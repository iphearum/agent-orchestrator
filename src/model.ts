import { AgentMessage, ChatResponse } from "./types";

export interface ModelProvider {
  id: string;
  name: string;
  protocol?: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  models: string[];
  model: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providers?: ModelProvider[];
  activeProviderId?: string;
  activeModel?: string;
}

export class OpenAICompatibleModel {
  constructor(private readonly config: () => ModelConfig = () => ({ baseUrl: "http://localhost:11434/v1", apiKey: "local", model: "qwen3:8b" })) {}

  async chat(
    messages: AgentMessage[],
    tools: any[],
    modelOverride?: string
  ): Promise<ChatResponse> {
    const cfg = this.config();
    const provider = cfg.providers?.find(item => item.id === cfg.activeProviderId) || cfg.providers?.[0];
    const baseUrl = (provider?.baseUrl || cfg.baseUrl).replace(/\/$/, "");
    const apiKey = provider?.apiKey || cfg.apiKey;
    const model = modelOverride || cfg.activeModel || provider?.model || cfg.model;

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
        body: JSON.stringify({ model, max_tokens: 4096, system, messages: conversation, tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description || "", input_schema: tool.function.parameters || { type: "object", properties: {} } })) })
      });
      if (!res.ok) throw new Error(`Model HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as any;
      return {
        content: data.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || null,
        toolCalls: data.content?.filter((part: any) => part.type === "tool_use").map((part: any) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input || {}) } })) || []
      };
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        temperature: 0.2
      })
    });

    if (!res.ok) {
      throw new Error(`Model HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Model returned no message.");

    return {
      content: msg.content ?? null,
      toolCalls: msg.tool_calls ?? []
    };
  }
}
