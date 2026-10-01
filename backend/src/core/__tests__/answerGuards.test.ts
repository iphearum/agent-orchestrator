import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../persistence/database";
import { AgentDecisionEngine } from "../decision";
import { Orchestrator } from "../orchestrator";
import { isAnswerOnlyRequest, looksUnfinished } from "../answerGuards";
import type { ChatResponse } from "../types";

describe("unfinished answers", () => {
  it("spots replies that end by announcing work instead of doing it", () => {
    // Both came back as final answers in a real Team run.
    expect(looksUnfinished("Perfect! Now let me create a comprehensive summary of what has been implemented and what needs to be done next:")).toBe(true);
    expect(looksUnfinished("Now I'll add the new command to extension.ts.")).toBe(true);
    expect(looksUnfinished("I found the schema.\n\nLet me check the indexes next...")).toBe(true);
  });

  it("accepts real answers, including ones that mention next steps", () => {
    expect(looksUnfinished("Hello! What would you like to work on?")).toBe(false);
    expect(looksUnfinished("The cache is rebuilt on start. Let me know if you want it persisted.")).toBe(false);
    expect(looksUnfinished("Next steps:\n1. Add an index.\n2. I'll review the migration afterwards.\n\n" + "Details. ".repeat(50))).toBe(false);
    expect(looksUnfinished("Here is the plan:\n\n1. Index messages\n2. Add FTS")).toBe(false);
    expect(looksUnfinished("Should I create the migration now?")).toBe(false);
  });
});

describe("answer-only requests", () => {
  it("treats questions as answer-only and requests for change as work", () => {
    for (const q of ["Any plan to do next for next implement?", "Give me some description of this project", "How should we store chat history?", "Check this project and recommend me", "What does the orchestrator do"]) expect(isAnswerOnlyRequest(q)).toBe(true);
    for (const r of ["Can you fix the login bug?", "Please carry out the task we agreed on in this discussion.", "Add a git tool", "Implement chat search", "Could you refactor the storage layer?"]) expect(isAnswerOnlyRequest(r)).toBe(false);
  });
});

let dir: string;
let db: AgentDatabase;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-guard-")); db = new AgentDatabase(dir); db.seedAgents(); });
afterEach(() => { db.connection.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

function scriptedModel(turns: Array<ChatResponse | ((tools: unknown[]) => ChatResponse)>) {
  const offered: unknown[][] = [];
  const prompts: string[] = [];
  const lastUser: string[] = [];
  return {
    offered, prompts, lastUser,
    chat: async (messages: Array<{ role: string; content: unknown }>, tools: unknown[]) => {
      offered.push(tools);
      prompts.push(String(messages[0]?.content ?? ""));
      lastUser.push(String([...messages].reverse().find(message => message.role === "user")?.content ?? ""));
      const next = turns.shift();
      return typeof next === "function" ? next(tools) : next ?? { content: "done", toolCalls: [] };
    }
  };
}
const newOrchestrator = (model: unknown) => new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });

describe("agent runs always end in an answer", () => {
  it("nudges an agent that announced a step, and returns the real answer", async () => {
    const model = scriptedModel([
      { content: "Perfect! Now let me create a comprehensive summary of what to do next:", toolCalls: [] },
      { content: "Next: 1) add FTS search, 2) index messages by conversation.", toolCalls: [] }
    ]);
    const answer = await newOrchestrator(model).runRoot("Any plan to do next?", "lead", false, { approvalMode: "approve" });
    expect(answer).toBe("Next: 1) add FTS search, 2) index messages by conversation.");
    expect(model.lastUser[1]).toContain("You announced a next step but did not take it");
    expect(model.offered[1].length).toBeGreaterThan(0);
  });

  it("asks for a final answer without tools after a second announcement, and accepts it", async () => {
    const model = scriptedModel([
      { content: "Let me check the database schema:", toolCalls: [] },
      { content: "Now I'll read the schema file.", toolCalls: [] },
      { content: "The schema stores messages per conversation; an FTS index would speed up search.", toolCalls: [] }
    ]);
    const answer = await newOrchestrator(model).runRoot("How is chat history stored?", "lead", false, { approvalMode: "approve" });
    expect(answer).toBe("The schema stores messages per conversation; an FTS index would speed up search.");
    expect(model.offered[2]).toEqual([]);
  });

  it("answers with what it has instead of failing at the turn limit", async () => {
    let n = 0;
    const search = (): ChatResponse => ({ content: null, toolCalls: [{ id: `s${n}`, type: "function", function: { name: "search_workspace", arguments: JSON.stringify({ query: `term${n++}` }) } }] });
    const model = scriptedModel([...Array.from({ length: 19 }, () => search), { content: "Best answer from the searches so far.", toolCalls: [] }]);
    const answer = await newOrchestrator(model).runRoot("Where is chat history searched?", "lead", false, { approvalMode: "approve" });
    expect(answer).toBe("Best answer from the searches so far.");
    expect(model.offered[19]).toEqual([]);
    expect(model.lastUser[19]).toContain("used all your tool turns");
  });

  it("tells every agent in the chain that a question is answer-only", async () => {
    const model = scriptedModel([
      { content: null, toolCalls: [{ id: "d1", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ agent_id: "database", instruction: "Summarise the storage design" }) } }] },
      { content: "Messages live in SQLite with per-conversation indexes.", toolCalls: [] },
      { content: "Storage: SQLite, indexed per conversation.", toolCalls: [] }
    ]);
    await newOrchestrator(model).runRoot("Give me some description of the storage", "lead", false, { approvalMode: "approve" });
    expect(model.prompts[0]).toContain("The client asked a question");
    expect(model.prompts[1]).toContain("The client asked a question");

    const work = scriptedModel([{ content: "Done.", toolCalls: [] }]);
    await newOrchestrator(work).runRoot("Add a git tool", "lead", false, { approvalMode: "approve" });
    expect(work.prompts[0]).not.toContain("The client asked a question");
  });
});

describe("read coverage", () => {
  it("points an agent back to text it already read instead of re-sending a shifted window", async () => {
    const { ReadCoverage } = await import("../answerGuards");
    const coverage = new ReadCoverage();
    expect(coverage.check("spec.md · lines 1657-1816 of 2246\n...")).toBeUndefined();
    const note = coverage.check("spec.md · lines 1660-1819 of 2246\n...");
    expect(note).toContain("already read most of spec.md");
    expect(note).toContain("next unread part starts at line 1817");
    expect(coverage.check("spec.md · lines 1817-1976 of 2246\n...")).toBeUndefined();
    expect(coverage.check("other.md · lines 1-100 of 100\n...")).toBeUndefined();
    expect(coverage.check("{\"error\":\"not found\"}")).toBeUndefined();
  });
});

describe("team plans come from the client's own request", () => {
  const discussion = `Use the agreed client discussion as context for this task. The final assignment takes precedence.\n\nDiscussion:\n${"Client: we talked about the frontend, backend, database schema and deployment pipeline at length. ".repeat(8)}\n\nFinal assignment:\n`;
  async function teamRequested(displayPrompt: string) {
    const routed: Array<{ teamPlanRequest?: unknown }> = [];
    const decisions = {
      route: async (state: { teamPlanRequest?: unknown }) => { routed.push(state); return { agent: { value: "lead", confidence: 1 }, source: "laya" }; },
      decide: async () => new AgentDecisionEngine().decide({ id: "lead" } as never, { agentId: "lead", agentName: "Lead", message: "", availableTools: [] }, [])
    };
    const model = { chat: async () => ({ content: "Answer.", toolCalls: [] }) };
    const orchestrator = new Orchestrator(db, model as any, undefined, decisions as any, { layaEnabled: true, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await orchestrator.runRoot(discussion + displayPrompt, "lead", true, { displayPrompt, approvalMode: "approve" });
    return Boolean(routed[0]?.teamPlanRequest);
  }

  it("does not ask Laya to split a question across agents, however long the discussion before it", async () => {
    expect(await teamRequested("Any plan to do next?")).toBe(false);
    expect(await teamRequested("Hello")).toBe(false);
    expect(await teamRequested("Add a settings page")).toBe(false);
  });

  it("still plans team work for team-sized requests and for carrying out the agreed discussion", async () => {
    expect(await teamRequested("Implement the login feature, write tests for it, and update the README")).toBe(true);
    expect(await teamRequested("Please carry out the task we agreed on in this discussion.")).toBe(true);
  });
});
