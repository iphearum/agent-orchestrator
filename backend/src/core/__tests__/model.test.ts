import { afterEach, describe, expect, it } from "bun:test";
import { OpenAICompatibleModel } from "../model";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

/** An OpenAI-compatible endpoint that streams the given deltas as server-sent events. */
function streamingServer(deltas: object[]) {
  server = Bun.serve({ port: 0, fetch: () => new Response(
    deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  ) });
  return new OpenAICompatibleModel(() => ({ baseUrl: `http://127.0.0.1:${server!.port}/v1`, apiKey: "local", model: "qwen3.5:0.8b" }));
}

describe("OpenAICompatibleModel reasoning", () => {
  it("reads Ollama's `reasoning` and vLLM/llama.cpp's `reasoning_content` as thinking", async () => {
    const model = streamingServer([{ reasoning: "Check the README. " }, { reasoning_content: "Then answer." }, { content: "It is a VS Code extension." }]);
    const thinking: string[] = [];
    const chunks: string[] = [];
    const result = await model.chat([{ role: "user", content: "What is this?" }], [], undefined, text => chunks.push(text), text => thinking.push(text));
    expect(thinking.join("")).toBe("Check the README. Then answer.");
    expect(result.thinkingText).toBe("Check the README. Then answer.");
    expect(result.content).toBe("It is a VS Code extension.");
    expect(chunks.join("")).toBe("It is a VS Code extension.");
  });
});

describe("OpenAICompatibleModel runaway reasoning", () => {
  it("detects reasoning that repeats itself or grows past the limit", async () => {
    const { isRunawayThinking, MAX_THINKING_CHARS } = await import("../model");
    const loop = "Wait, I should check if there is any instruction about the Supervisor context that overrides this. Okay, I will respond as an AI assistant ready to help with the task definition request. ";
    expect(isRunawayThinking("Let me think about the greeting and reply briefly.")).toBe(false);
    expect(isRunawayThinking(loop.repeat(6))).toBe(true);
    expect(isRunawayThinking("Varied reasoning step ".repeat(1).padEnd(MAX_THINKING_CHARS + 1, "abcdefghij"))).toBe(true);
  });

  it("stops a looping stream and answers once without reasoning, at the provider's default temperature while thinking", async () => {
    const bodies: any[] = [];
    const loop = "Wait, I should check the instructions again before I greet the client back properly. ";
    server = Bun.serve({ port: 0, fetch: async request => {
      const body = await request.json();
      bodies.push(body);
      const deltas = body.reasoning_effort === "none"
        ? [{ content: "Hello! What would you like to work on?" }]
        : Array.from({ length: 200 }, () => ({ reasoning: loop }));
      return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    const model = new OpenAICompatibleModel(() => ({ baseUrl: `http://127.0.0.1:${server!.port}/v1`, apiKey: "local", model: "qwen3.5:0.8b" }));
    const thinking: string[] = [];
    const result = await model.chat([{ role: "user", content: "Hello" }], [], { reasoningEffort: "medium" }, () => undefined, text => thinking.push(text));
    expect(result.content).toBe("Hello! What would you like to work on?");
    expect(bodies.map(body => body.reasoning_effort)).toEqual(["medium", "none"]);
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[1].temperature).toBe(0.2);
    expect(thinking.join("")).toContain("Reasoning was repeating itself");
    expect(thinking.join("").length).toBeLessThan(loop.length * 40);
  });
});
