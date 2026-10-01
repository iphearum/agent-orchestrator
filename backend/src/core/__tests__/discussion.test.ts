import { describe, expect, it } from "bun:test";
import { DiscussionService, estimateDiscussionEffort, selectDiscussionAdvisors } from "../discussion";
import type { AgentDefinition, AgentMessage } from "../types";

const agents: AgentDefinition[] = [
  { id: "lead", name: "Lead", description: "Coordinates the team", systemPrompt: "Lead role", skills: [], canDelegate: true },
  { id: "coder", name: "Coder", description: "Builds chat interfaces", systemPrompt: "Coder role", skills: ["frontend", "webview"], canDelegate: true },
  { id: "database", name: "Database", description: "Database and chat history storage", systemPrompt: "Database role", skills: ["sqlite", "history"], canDelegate: true },
  { id: "researcher", name: "Researcher", description: "Investigates requests", systemPrompt: "Researcher role", skills: ["research", "analysis"], canDelegate: true },
  { id: "reviewer", name: "Reviewer", description: "Checks quality and risks", systemPrompt: "Reviewer role", skills: ["review", "quality"], canDelegate: false }
];

describe("discussion advisers", () => {
  it("uses a small relevant group by default and the whole roster when explicitly asked", () => {
    const relevant = selectDiscussionAdvisors("How should we improve chat history storage?", agents).map(agent => agent.id);
    expect(relevant).toContain("database");
    expect(relevant.length).toBeLessThanOrEqual(3);
    expect(selectDiscussionAdvisors("Please ask all agents", agents).map(agent => agent.id)).toEqual(["coder", "database", "researcher", "reviewer"]);
  });

  it("consults nobody for a greeting so the Supervisor replies directly", () => {
    expect(selectDiscussionAdvisors("Hello", agents)).toEqual([]);
    expect(selectDiscussionAdvisors("Hi, thank you!", agents)).toEqual([]);
  });

  it("estimates effort from the message when the client leaves it on Auto", () => {
    expect(estimateDiscussionEffort("Hello")).toBe("low");
    expect(estimateDiscussionEffort("Can you rename the button label?")).toBe("low");
    expect(estimateDiscussionEffort("How should we design chat history storage?")).toBe("medium");
    expect(estimateDiscussionEffort("Why does this fail?\n```\nTypeError: x is undefined\n```\nShould we refactor it?")).toBe("high");
    expect(estimateDiscussionEffort("Look at this", { images: 1 })).toBe("medium");
  });

  it("lets the Supervisor answer directly when it decides no advice is needed", async () => {
    const calls: Array<{ tools: unknown[]; effort?: string }> = [];
    const model = {
      chat: async (_messages: AgentMessage[], tools: unknown[], selection: { reasoningEffort?: string }) => {
        calls.push({ tools, effort: selection.reasoningEffort });
        return { content: "Hi! What would you like to work on?", toolCalls: [] };
      }
    };
    const sessions = { messages: () => [], addDiscussionMessage: () => undefined };
    const consulted: string[] = [];
    const efforts: string[] = [];
    const answer = await new DiscussionService(model as never, sessions as never).reply("conversation", "Hello", {
      agentId: "lead", supervisorDiscussion: true, agents,
      onConsultation: id => consulted.push(id), onEffort: effort => efforts.push(effort)
    });
    expect(answer).toBe("Hi! What would you like to work on?");
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toHaveLength(1);
    expect(calls[0].effort).toBe("none");
    expect(consulted).toEqual([]);
    expect(efforts).toEqual([]);
  });

  it("consults the specialists the Supervisor chooses after thinking, then synthesizes a reply", async () => {
    const calls: Array<{ messages: AgentMessage[]; tools: unknown[]; effort?: string }> = [];
    const model = {
      chat: async (messages: AgentMessage[], tools: unknown[], selection: { reasoningEffort?: string }) => {
        calls.push({ messages, tools, effort: selection.reasoningEffort });
        const system = String(messages[0]?.content);
        if (tools.length) return { content: "Let me check with the team.", toolCalls: [{ id: "c1", type: "function", function: { name: "consult_agents", arguments: JSON.stringify({ agents: ["database", "reviewer", "unknown"], question: "Which storage risks matter?" }) } }] };
        if (system.includes("Database role")) return { content: "Database recommends indexing by conversation.", toolCalls: [] };
        if (system.includes("Reviewer role")) return { content: "Reviewer recommends defining success criteria.", toolCalls: [] };
        return { content: "I consulted Database and Reviewer and combined their recommendations.", toolCalls: [] };
      }
    };
    const saved: string[] = [];
    const sessions = {
      messages: () => [],
      addDiscussionMessage: (_id: string, _agent: string | null, _role: string, text: string) => saved.push(text)
    };
    const seen: string[] = [];
    let resets = 0;
    const prompt = "How should we design chat history storage?";
    const answer = await new DiscussionService(model as never, sessions as never).reply("conversation", prompt, {
      agentId: "lead", supervisorDiscussion: true, agents,
      onConsultation: (id, advice) => { if (advice) seen.push(id); },
      onStreamReset: () => resets++
    });

    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every(call => call.tools.length === 0)).toBe(true);
    expect(calls.every(call => call.effort === "medium")).toBe(true);
    expect(calls.slice(1, 3).map(call => String(call.messages[0].content)).join(" ")).toContain("Which storage risks matter?");
    expect(String(calls.at(-1)!.messages[0].content)).toContain("Reviewer recommends defining success criteria.");
    expect(seen.sort()).toEqual(["database", "reviewer"]);
    expect(resets).toBe(1);
    expect(answer).toContain("I consulted Database and Reviewer");
    expect(saved).toEqual([prompt, answer]);
  });

  it("uses Laya's decision: its effort, and no consult tool after a confident no", async () => {
    const calls: Array<{ tools: unknown[]; effort?: string }> = [];
    const model = { chat: async (_m: AgentMessage[], tools: unknown[], selection: { reasoningEffort?: string }) => { calls.push({ tools, effort: selection.reasoningEffort }); return { content: "Sure, here is how I see it.", toolCalls: [] }; } };
    const sessions = { messages: () => [], addDiscussionMessage: () => undefined };
    const inputs: unknown[] = [];
    const notes: string[] = [];
    await new DiscussionService(model as never, sessions as never).reply("conversation", "Explain the options", {
      agentId: "lead", supervisorDiscussion: true, agents,
      decide: async input => { inputs.push(input); return { effort: { value: "high", confidence: .95, source: "laya" }, consult: { value: false, confidence: .96, mode: "execute" }, source: "laya" }; },
      onEffort: (effort, decision) => notes.push(`${effort}:${decision?.source}`)
    });
    expect(inputs).toEqual([expect.objectContaining({ prompt: "Explain the options", supervisor: true, effort: true })]);
    expect(calls).toEqual([{ tools: [], effort: "high" }]);
    expect(notes).toEqual(["high:laya"]);
  });

  it("does not ask Laya when the client set the effort outside Supervisor mode", async () => {
    const model = { chat: async () => ({ content: "Hi!", toolCalls: [] }) };
    const sessions = { messages: () => [], addDiscussionMessage: () => undefined };
    let asked = false;
    await new DiscussionService(model as never, sessions as never).reply("conversation", "Hello", {
      agentId: "coder", reasoningEffort: "low", decide: async () => { asked = true; throw new Error("not expected"); }
    });
    expect(asked).toBe(false);
  });

  it("retries an empty reply once without reasoning instead of failing", async () => {
    const efforts: Array<string | undefined> = [];
    const model = { chat: async (_m: AgentMessage[], _t: unknown[], selection: { reasoningEffort?: string }) => { efforts.push(selection.reasoningEffort); return efforts.length === 1 ? { content: null, thinkingText: "Wait, let me check again…", toolCalls: [] } : { content: "Hello! What would you like to work on?", toolCalls: [] }; } };
    const sessions = { messages: () => [], addDiscussionMessage: () => undefined };
    const answer = await new DiscussionService(model as never, sessions as never).reply("conversation", "Hello", { agentId: "coder", thinking: "on" });
    expect(answer).toBe("Hello! What would you like to work on?");
    expect(efforts).toEqual(["medium", "none"]);
  });

  it("continues the discussion when one adviser fails", async () => {
    const model = {
      chat: async (messages: AgentMessage[]) => {
        const system = String(messages[0]?.content);
        if (system.includes("Researcher role")) throw new Error("adviser unavailable");
        return { content: system.includes("Reviewer role") ? "Define clear acceptance criteria." : "The reviewer recommends clear acceptance criteria." };
      }
    };
    const sessions = { messages: () => [], addDiscussionMessage: () => undefined };
    const answer = await new DiscussionService(model as never, sessions as never).reply("conversation", "Ask all agents to review this goal", {
      agentId: "lead",
      supervisorDiscussion: true,
      agents: [agents[0], agents[3], agents[4]]
    });
    expect(answer).toContain("reviewer recommends clear acceptance criteria");
  });
});
