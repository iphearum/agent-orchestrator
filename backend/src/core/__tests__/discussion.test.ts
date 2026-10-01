import { describe, expect, it } from "bun:test";
import { DiscussionService, selectDiscussionAdvisors } from "../discussion";
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

  it("collects tool-free specialist advice before the Supervisor synthesizes a discussion reply", async () => {
    const calls: Array<{ messages: AgentMessage[]; tools: unknown[] }> = [];
    const model = {
      chat: async (messages: AgentMessage[], tools: unknown[]) => {
        calls.push({ messages, tools });
        const system = String(messages[0]?.content);
        return { content: system.includes("Researcher role") ? "Researcher recommends narrowing the goal." : system.includes("Reviewer role") ? "Reviewer recommends defining success criteria." : "I consulted Researcher and Reviewer and combined their recommendations." };
      }
    };
    const saved: string[] = [];
    const sessions = {
      messages: () => [],
      addDiscussionMessage: (_id: string, _agent: string | null, _role: string, text: string) => saved.push(text)
    };
    const seen: string[] = [];
    const service = new DiscussionService(model as never, sessions as never);
    const expectedAdvisors = selectDiscussionAdvisors("Review this project and recommend improvements", agents).map(agent => agent.id).sort();
    const answer = await service.reply("conversation", "Review this project and recommend improvements", {
      agentId: "lead",
      supervisorDiscussion: true,
      agents,
      onConsultation: (id, advice) => { if (advice) seen.push(`${id}:${advice}`); }
    });

    expect(calls).toHaveLength(expectedAdvisors.length + 1);
    expect(calls.every(call => call.tools.length === 0)).toBe(true);
    expect(calls.at(-1)!.messages.map(message => String(message.content)).join(" ")).toContain("Reviewer recommends defining success criteria.");
    expect(seen.map(item => item.split(":")[0]).sort()).toEqual(expectedAdvisors);
    expect(answer).toContain("I consulted Researcher and Reviewer");
    expect(saved).toEqual(["Review this project and recommend improvements", answer]);
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
