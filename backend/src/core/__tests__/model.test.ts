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
