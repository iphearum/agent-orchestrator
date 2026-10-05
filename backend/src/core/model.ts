import { AgentMessage, ChatResponse } from "./types";

export interface ModelProvider {
  id: string;
  name: string;
  protocol?: "openai" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  models: string[];
  model: string;
  /** Optional OpenAI-compatible embedding model for semantic memory retrieval. */
  embeddingModel?: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providers?: ModelProvider[];
  activeProviderId?: string;
  activeModel?: string;
}

/** "none" asks a thinking model (e.g. Qwen on Ollama) to answer without reasoning. */
export type ProviderReasoningEffort = "none" | "low" | "medium" | "high";
export interface AgentModelSelection { providerId?: string; model?: string; reasoningEffort?: ProviderReasoningEffort; }

/** Streamed reasoning longer than this, or repeating itself, is treated as a runaway loop. */
export const MAX_THINKING_CHARS = 60_000;
const REPEAT_PROBE_CHARS = 240;

/** True when the latest stretch of reasoning already appeared twice before: small models can loop until the context is full. */
export function isRunawayThinking(text: string): boolean {
  if (text.length > MAX_THINKING_CHARS) return true;
  if (text.length < REPEAT_PROBE_CHARS * 4) return false;
  const probe = text.slice(-REPEAT_PROBE_CHARS);
  let count = 0;
  for (let at = text.indexOf(probe); at !== -1 && count < 3; at = text.indexOf(probe, at + 1)) count++;
  return count >= 3;
}

class RunawayThinkingError extends Error {}

export class OpenAICompatibleModel {
  constructor(private readonly config: () => ModelConfig | Promise<ModelConfig> = () => ({ baseUrl: "http://localhost:11434/v1", apiKey: "local", model: "qwen3:8b" })) {}

  async embeddingModelName(selection?: string | AgentModelSelection): Promise<string | undefined> {
    const cfg = await this.config();
    const selected = typeof selection === "string" ? { model: selection } : selection;
    const provider = cfg.providers?.find(item => item.id === selected?.providerId)
      || cfg.providers?.find(item => item.id === cfg.activeProviderId)
      || cfg.providers?.[0];
    return provider && provider.protocol !== "anthropic" ? provider.embeddingModel?.trim() || undefined : undefined;
  }

  /** Embeddings are optional and only available for OpenAI-compatible providers with an explicit model configured. */
  async embed(texts: string[], selection?: string | AgentModelSelection): Promise<{ model: string; vectors: number[][] } | undefined> {
    if (!texts.length) return undefined;
    const cfg = await this.config();
    const selected = typeof selection === "string" ? { model: selection } : selection;
    const provider = cfg.providers?.find(item => item.id === selected?.providerId)
      || cfg.providers?.find(item => item.id === cfg.activeProviderId)
      || cfg.providers?.[0];
    const embeddingModel = provider?.embeddingModel?.trim();
    if (!provider || provider.protocol === "anthropic" || !embeddingModel) return undefined;
    const baseUrl = (provider.baseUrl || cfg.baseUrl).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({ model: embeddingModel, input: texts })
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> };
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error("Embedding provider returned an unexpected number of vectors.");
    const vectors = new Array<number[]>(texts.length);
    for (const item of payload.data) {
      const index = Number.isInteger(item.index) ? item.index! : payload.data.indexOf(item);
      if (index < 0 || index >= texts.length || !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Embedding provider returned an invalid vector.");
      }
      vectors[index] = item.embedding as number[];
    }
    if (vectors.some(vector => !Array.isArray(vector))) throw new Error("Embedding provider omitted one or more vectors.");
    return { model: embeddingModel, vectors };
  }

  async chat(
    messages: AgentMessage[],
    tools: any[],
    selection?: string | AgentModelSelection,
    onChunk?: (text: string) => void,
    onThinking?: (text: string) => void
  ): Promise<ChatResponse> {
    const cfg = await this.config();
    const selected = typeof selection === "string" ? { model: selection } : selection;
    const provider = cfg.providers?.find(item => item.id === selected?.providerId)
      || cfg.providers?.find(item => item.id === cfg.activeProviderId)
      || cfg.providers?.[0];
    const baseUrl = (provider?.baseUrl || cfg.baseUrl).replace(/\/$/, "");
    const apiKey = provider?.apiKey || cfg.apiKey;
    const model = selected?.model || (selected?.providerId ? provider?.model : cfg.activeModel) || provider?.model || cfg.model;

    if (provider?.protocol === "anthropic") {
      const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
      const contentBlocks = (content: AgentMessage["content"]): any[] => typeof content === "string"
        ? [{ type: "text", text: content }]
        : content.map(part => part.type === "text" ? { type: "text", text: part.text } : (() => {
          const match = part.image_url.url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
          return match ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } } : { type: "text", text: part.image_url.url };
        })());
      const conversation: any[] = [];
      for (const message of messages.filter(item => item.role !== "system")) {
        if (message.role === "tool") {
          conversation.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }] });
        } else if (message.role === "assistant" && message.tool_calls?.length) {
          const blocks = [...contentBlocks(message.content), ...message.tool_calls.map(call => ({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") }))];
          conversation.push({ role: "assistant", content: blocks });
        } else {
          conversation.push({ role: message.role === "assistant" ? "assistant" : "user", content: contentBlocks(message.content) });
        }
      }
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, system, messages: conversation, tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description || "", input_schema: tool.function.parameters || { type: "object", properties: {} } })), ...(onChunk ? { stream: true } : {}) })
      });
      if (!res.ok) throw new Error(`Model HTTP ${res.status}: ${await res.text()}`);
      if (onChunk && res.headers.get("content-type")?.includes("text/event-stream")) {
        let content = "";
        let thinkingText = "";
        const blocks = new Map<number, { id: string; name: string; input: string }>();
        await this.consumeSSE(res, data => {
          if (data.type === "content_block_start" && data.content_block?.type === "tool_use") blocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, input: JSON.stringify(data.content_block.input || {}) });
          if (data.type !== "content_block_delta") return;
          if (data.delta?.type === "text_delta" && data.delta.text) { content += data.delta.text; onChunk(data.delta.text); }
          const thought = data.delta?.summary;
          if (data.delta?.type === "thinking_summary_delta" && typeof thought === "string" && thought) { thinkingText += thought; onThinking?.(thought); }
          if (data.delta?.type === "input_json_delta") {
            const block = blocks.get(data.index);
            if (block) block.input = (block.input === "{}" ? "" : block.input) + (data.delta.partial_json || "");
          }
        });
        return { content: content || null, thinkingText: thinkingText || null, toolCalls: [...blocks.values()].map(block => ({ id: block.id, type: "function" as const, function: { name: block.name, arguments: block.input || "{}" } })) };
      }
      const data = await res.json() as any;
      const thinkingText = data.content?.filter((part: any) => part.type === "thinking_summary").map((part: any) => part.text || part.summary || "").join("\n") || null;
      if (thinkingText) onThinking?.(thinkingText);
      return {
        thinkingText,
        content: data.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || null,
        toolCalls: data.content?.filter((part: any) => part.type === "tool_use").map((part: any) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input || {}) } })) || []
      };
    }

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        // Low temperature keeps plain answers focused, but makes thinking models repeat themselves; let reasoning use the provider default.
        ...(!selected?.reasoningEffort || selected.reasoningEffort === "none" ? { temperature: 0.2 } : {}),
        ...(onChunk ? { stream: true } : {}),
        ...(selected?.reasoningEffort ? { reasoning_effort: selected.reasoningEffort } : {})
      })
    });

    if (!res.ok) {
      const body = await res.text();
      // Some OpenAI-compatible models reject reasoning_effort; retry once with the provider's default reasoning.
      if (res.status === 400 && selected?.reasoningEffort && /reasoning/i.test(body)) {
        return this.chat(messages, tools, { ...selected, reasoningEffort: undefined }, onChunk, onThinking);
      }
      throw new Error(`Model HTTP ${res.status}: ${body}`);
    }

    if (onChunk && res.headers.get("content-type")?.includes("text/event-stream")) {
      let content = "";
      let thinkingText = "";
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let checkedAt = 0;
      try {
        await this.consumeSSE(res, data => {
        const delta = data.choices?.[0]?.delta;
        if (typeof delta?.content === "string" && delta.content) { content += delta.content; onChunk(delta.content); }
        // Ollama streams a thinking model's reasoning as "reasoning"; vLLM, llama.cpp and DeepSeek use "reasoning_content".
        const reasoning = [delta?.reasoning_content, delta?.reasoning, delta?.reasoning_summary, delta?.thinking_summary].find(value => typeof value === "string" && value);
        if (reasoning) {
          thinkingText += reasoning; onThinking?.(reasoning);
          if (!content && thinkingText.length - checkedAt >= 500) {
            checkedAt = thinkingText.length;
            if (isRunawayThinking(thinkingText)) throw new RunawayThinkingError();
          }
        }
        for (const call of delta?.tool_calls || []) {
          const current = calls.get(call.index) || { id: "", name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          calls.set(call.index, current);
        }
        });
      } catch (error) {
        if (!(error instanceof RunawayThinkingError)) throw error;
        // Abort so the provider stops generating, then answer once without reasoning.
        controller.abort();
        if (selected?.reasoningEffort === "none") throw new Error(`The model${model ? ` (${model})` : ""} kept reasoning in a loop and gave no answer. Try a larger model.`);
        onThinking?.("\n\n_Reasoning was repeating itself, so it was stopped. Answering directly._");
        return this.chat(messages, tools, { ...selected, reasoningEffort: "none" }, onChunk, onThinking);
      }
      return { content: content || null, thinkingText: thinkingText || null, toolCalls: [...calls.values()].map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" } })) };
    }

    const data = await res.json() as any;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Model returned no message.");
    const thinkingText = [msg.reasoning_content, msg.reasoning, msg.reasoning_summary, msg.thinking_summary].find(value => typeof value === "string" && value) || null;
    if (thinkingText) onThinking?.(thinkingText);

    return {
      thinkingText,
      content: msg.content ?? null,
      toolCalls: msg.tool_calls ?? []
    };
  }

  private async consumeSSE(response: Response, onData: (data: any) => void) {
    if (!response.body) throw new Error("The model provider did not return a readable stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    const dispatch = () => {
      if (!dataLines.length) return;
      const data = dataLines.join("\n"); dataLines = [];
      if (data === "[DONE]") return;
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { return; }
      if (parsed?.type === "error" || parsed?.error) throw new Error(String(parsed.error?.message || parsed.message || "The model provider stream failed."));
      onData(parsed);
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) dispatch();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    dispatch();
  }
}
