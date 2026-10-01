import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../persistence/database";
import { AgentDecisionEngine } from "../decision";
import { Orchestrator } from "../orchestrator";
import type { ChatResponse } from "../types";
import { RuntimeActivity } from "../activity";
import { WorkbenchViews } from "../../vscode/webviews/views";

let dir: string;
let db: AgentDatabase;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-deleg-")); db = new AgentDatabase(dir); db.seedAgents(); });
afterEach(() => { db.connection.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

type OfferedTool = { function: { name: string; parameters?: { properties?: Record<string, { enum?: string[] }> } } };

/** Replays scripted turns (shared by every agent, in call order) and records the tools and prompts each turn got. */
function scriptedModel(turns: ChatResponse[]) {
  const offered: OfferedTool[][] = [];
  const prompts: string[] = [];
  return {
    offered, prompts,
    chat: async (messages: Array<{ role: string; content: unknown }>, tools: OfferedTool[]) => {
      offered.push(tools);
      prompts.push(String(messages[0]?.content ?? ""));
      return turns.shift() ?? { content: "done", toolCalls: [] };
    }
  };
}

const ask = (id: string, agentId: string, question: string): ChatResponse => ({
  content: null,
  toolCalls: [{ id, type: "function", function: { name: "ask_agent", arguments: JSON.stringify({ agent_id: agentId, question }) } }]
});
const names = (tools: OfferedTool[]) => tools.map(tool => tool.function.name);
const askTargets = (tools: OfferedTool[]) => tools.find(tool => tool.function.name === "ask_agent")?.function.parameters?.properties?.agent_id?.enum;

describe("agent hand-offs", () => {
  it("never offers an agent itself or its requester, and stops a sub-agent retrying a failed self-ask", async () => {
    // The trace from the bug report: Lead consults Planner, and Planner keeps "asking" itself for project details.
    const model = scriptedModel([
      ask("l1", "planner", "What are the key phases of this project?"),
      ask("p1", "planner", "Could you clarify the project description?"),
      ask("p2", "planner", "Could you clarify the project description?"),
      { content: "Assuming a web app: 1) scope 2) build 3) release. Open question: what is the project?", toolCalls: [] },
      { content: "Here is a draft plan; please tell me more about the project.", toolCalls: [] }
    ]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    const answer = await orchestrator.runRoot("Can you give me project description", "lead", false, { approvalMode: "approve" });

    expect(answer).toBe("Here is a draft plan; please tell me more about the project.");
    // Lead may ask anyone but itself; Planner may ask anyone but itself and Lead.
    expect(askTargets(model.offered[0])).toContain("planner");
    expect(askTargets(model.offered[0])).not.toContain("lead");
    expect(askTargets(model.offered[1])).not.toContain("planner");
    expect(askTargets(model.offered[1])).not.toContain("lead");
    // Planner is told it works for Lead and cannot ask the user.
    expect(model.prompts[1]).toContain("You are working for lead, not talking to the user");

    const runs = db.connection.prepare("SELECT agent_id, status, result_json FROM tool_runs WHERE tool_name = 'ask_agent' ORDER BY rowid").all() as Array<{ agent_id: string; status: string; result_json: string }>;
    expect(runs.map(run => `${run.agent_id}:${run.status}`)).toEqual(["planner:failed", "planner:failed", "lead:completed"]);
    // The cycle error says what to do instead, and the identical retry is refused without running again.
    expect(runs[0].result_json).toContain("You cannot ask or delegate to yourself");
    expect(runs[0].result_json).toContain("list your questions, and lead will pass them on");
    expect(runs[1].result_json).toContain("already failed");
    // After two failed hand-offs Planner is no longer offered them, so it answers.
    expect(names(model.offered[3])).not.toContain("ask_agent");
    expect(names(model.offered[3])).not.toContain("delegate_task");
  });

  it("lets the lead read the workspace and tells it to look before asking the user", async () => {
    // "Give me project description" used to get questions back: the lead (planner profile) had no read tools.
    const model = scriptedModel([{ content: "It is a VS Code extension.", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await orchestrator.runRoot("Give me project description", "lead", false, { approvalMode: "approve" });
    expect(names(model.offered[0])).toEqual(expect.arrayContaining(["search_workspace", "read_file", "file_outline"]));
    expect(model.prompts[0]).toContain("Look before you ask");
    expect(names(model.offered[0])).not.toContain("write_file");
  });

  it("offers no hand-off tools when no agent is reachable", async () => {
    const model = scriptedModel([{ content: "ok", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 0, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await orchestrator.runRoot("hello", "lead", false, { approvalMode: "approve" });
    expect(names(model.offered[0])).not.toContain("ask_agent");
    expect(names(model.offered[0])).not.toContain("delegate_task");
  });
});

describe("empty answers", () => {
  it("asks once more when the model returns neither text nor a tool call", async () => {
    const model = scriptedModel([{ content: null, toolCalls: [] }, { content: "Here is the document.", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 0, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    expect(await orchestrator.runRoot("Write me a document", "lead", false, { approvalMode: "approve" })).toBe("Here is the document.");
    expect(model.offered).toHaveLength(2);
  });

  it("fails with a clear message instead of saving '(no result)' when the answer stays empty", async () => {
    const model = scriptedModel([{ content: "", toolCalls: [], thinkingText: "Thinking..." }, { content: "  ", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 0, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await expect(orchestrator.runRoot("Write me a document", "lead", false, { approvalMode: "approve", model: "qwen3.5:0.8b" })).rejects.toThrow("The model (qwen3.5:0.8b) returned an empty answer");
    const task = db.connection.prepare("SELECT status, result FROM tasks WHERE parent_id IS NULL").get() as { status: string; result: string };
    expect(task.status).toBe("blocked");
    expect(task.result).not.toBe("(no result)");
  });
});

describe("rules fallback routing", () => {
  it("sends documentation requests to the documenter", () => {
    const { LayaRuntime } = require("../decision");
    const decision = new LayaRuntime().decide({ agentId: "lead", agentName: "Lead", message: "Write me a document for the setup", availableTools: [] }, "global", db.listAgents());
    expect(decision.agent.value).toBe("documenter");
  });
});

describe("routing request size", () => {
  /** Records the state the orchestrator sends to Laya for routing. */
  class RecordingDecisions extends AgentDecisionEngine {
    states: any[] = [];
    async route(state: any, agents: any[]) { this.states.push(state); return super.route(state, agents); }
  }

  it("asks Laya for a team plan only when the request looks like team work", async () => {
    const decisions = new RecordingDecisions();
    const run = async (message: string) => {
      const orchestrator = new Orchestrator(db, scriptedModel([{ content: "ok", toolCalls: [] }]) as any, undefined, decisions, { layaEnabled: true, maxDelegationDepth: 0, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
      await orchestrator.runRoot(message, "lead", true, { approvalMode: "approve" });
    };
    await run("Write me a documents for that.");
    await run("Fix the login bug and write tests for it");
    expect(decisions.states[0].teamPlanRequest).toBeUndefined();
    expect(decisions.states[1].teamPlanRequest?.agents.length).toBeGreaterThan(0);
  });
});

describe("misnamed hand-off arguments", () => {
  const call = (id: string, name: string, args: object): ChatResponse => ({ content: null, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

  it("accepts the agent and text under the names small models use", async () => {
    // The exact call from the bug report: the planner id under task_id, the text under task_description.
    const model = scriptedModel([
      call("c1", "delegate_task", { task_id: "planner", task_description: "Plan the documentation work." }),
      { content: "Plan: outline, draft, review.", toolCalls: [] },
      { content: "Here is the plan.", toolCalls: [] }
    ]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    expect(await orchestrator.runRoot("Help me please", "coder", false, { approvalMode: "approve" })).toBe("Here is the plan.");
    const run = db.connection.prepare("SELECT status, result_json FROM tool_runs WHERE tool_name = 'delegate_task'").get() as { status: string; result_json: string };
    expect(run.status).toBe("completed");
    expect(run.result_json).toContain("planner");
  });

  it("explains what is missing instead of looking up agent 'undefined'", async () => {
    const model = scriptedModel([call("c1", "delegate_task", { task_description: "Do it" }), { content: "ok", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await orchestrator.runRoot("Help me please", "coder", false, { approvalMode: "approve" });
    const run = db.connection.prepare("SELECT result_json FROM tool_runs WHERE tool_name = 'delegate_task'").get() as { result_json: string };
    expect(run.result_json).toContain('delegate_task needs \\"agent_id\\" (one of:');
    expect(run.result_json).toContain("No agent was named.");
    expect(run.result_json).not.toContain("undefined");
  });
});

describe("rules routing respects the addressed agent", () => {
  const route = (message: string) => {
    const { LayaRuntime } = require("../decision");
    return new LayaRuntime().decide({ agentId: "lead", agentName: "global", message, availableTools: [] }, "global", db.listAgents()).agent.value;
  };
  it("keeps or picks the agent the user named, and only picks the coder for coding words", () => {
    expect(route("Hey lead, help me please")).toBe("lead");
    expect(route("@planner break this into steps")).toBe("planner");
    expect(route("Fix the null pointer bug in login")).toBe("coder");
    expect(route("Can you help me?")).toBe("lead");
  });
});


describe("tool failures", () => {
  const call = (id: string, name: string, args: unknown): ChatResponse => ({ content: null, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

  it("returns a throwing tool's error to the model instead of ending the run", async () => {
    // Task #57: read_file threw "Use a non-empty workspace-relative path." and the whole run stopped.
    const model = scriptedModel([call("r1", "read_file", { path: "" }), { content: "Answered without the file.", toolCalls: [] }]);
    const workspace = { execute: async () => { throw new Error("Use a non-empty workspace-relative path."); } };
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 },
      undefined, undefined, undefined, undefined, undefined, workspace as any);
    const answer = await orchestrator.runRoot("Describe this project structure", "lead", false, { approvalMode: "approve" });

    expect(answer).toBe("Answered without the file.");
    const run = db.connection.prepare("SELECT status, result_json FROM tool_runs WHERE tool_name = 'read_file'").get() as { status: string; result_json: string };
    expect(run.status).toBe("failed");
    expect(run.result_json).toContain("read_file failed: Use a non-empty workspace-relative path.");
  });

  it("offers expand_tool_result only after a result was shortened", async () => {
    // Task #56: with nothing to expand, the model invented tool_run_id "agent-orchestrator-extension".
    const model = scriptedModel([call("s1", "search_workspace", { query: "orchestrator" }), { content: "done", toolCalls: [] }]);
    const workspace = { execute: async () => JSON.stringify({ matches: "x".repeat(12_000) }) };
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 },
      undefined, undefined, undefined, undefined, undefined, workspace as any);
    await orchestrator.runRoot("Find the orchestrator", "lead", false, { approvalMode: "approve" });

    expect(names(model.offered[0])).not.toContain("expand_tool_result");
    expect(names(model.offered[1])).toContain("expand_tool_result");
  });
});

describe("agents working as a team", () => {
  type Call = { agent: string; user: string; system: string; tools: string[] };
  /** Each agent replays its own script (read from its system prompt), so parallel runs stay deterministic. */
  function teamModel(scripts: Record<string, Array<ChatResponse | Error>>) {
    const calls: Call[] = [];
    return {
      calls,
      chat: async (messages: Array<{ role: string; content: unknown }>, tools: OfferedTool[]) => {
        const system = String(messages[0]?.content ?? "");
        const agent = /You are agent "([^"]+)"/.exec(system)?.[1] ?? "?";
        const tool = [...messages].reverse().find(message => message.role === "tool");
        calls.push({ agent, user: String(messages.find(message => message.role === "user")?.content ?? "") + (tool ? `\n[tool] ${String(tool.content)}` : ""), system, tools: names(tools) });
        const next = scripts[agent]?.shift() ?? { content: `${agent} done.`, toolCalls: [] };
        if (next instanceof Error) throw next;
        return next;
      }
    };
  }
  const call = (id: string, name: string, args: unknown): ChatResponse => ({ content: null, toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const designTeam = call("t1", "delegate_team", { tasks: [
    { agent_id: "researcher", instruction: "Check related changes" },
    { agent_id: "coder", instruction: "Inspect and fix the code" },
    { agent_id: "devops", instruction: "Check the environment" },
    { agent_id: "reviewer", instruction: "Review the changes", after: ["researcher", "coder", "DevOps"] }
  ] });
  const config = { layaEnabled: false, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 };

  it("lets the lead run the team it chooses: specialists in parallel, the reviewer after them", async () => {
    const model = teamModel({ lead: [designTeam, { content: "Fixed: null check added and reviewed.", toolCalls: [] }] });
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), config);
    const answer = await orchestrator.runRoot("Fix authentication 500 error", "lead", true, { approvalMode: "approve", conversationId: "c1" });

    expect(answer).toBe("Fixed: null check added and reviewed.");
    // The request suggests a team, but only as advice; the lead has the tools to run any team it wants.
    expect(model.calls[0].system).toContain("Suggested team for this request (adjust it as you see fit): researcher; coder; devops; reviewer after researcher, coder, devops.");
    expect(model.calls[0].tools).toEqual(expect.arrayContaining(["ask_agent", "delegate_task", "delegate_team"]));
    expect(model.calls.map(c => c.agent)).toEqual(["lead", "researcher", "coder", "devops", "reviewer", "lead"]);
    const review = model.calls.find(c => c.agent === "reviewer")!;
    expect(review.user).toContain("Your part of a team task from Lead: Review the changes");
    expect(review.user).toContain("Result from Coder:\ncoder done.");
    // Every result comes back to the lead as one tool result.
    expect(model.calls.at(-1)!.user).toContain('"agent":"reviewer","status":"completed","result":"reviewer done."');
    // Team members are full agents: they may call other agents too.
    expect(model.calls.find(c => c.agent === "coder")!.tools).toEqual(expect.arrayContaining(["ask_agent", "delegate_team"]));
    // The reviewer can't hand work off (can-delegate is off) but can still consult anyone.
    expect(review.tools).toContain("ask_agent");
    expect(review.tools).not.toContain("delegate_team");

    const root = (db.connection.prepare("SELECT id FROM tasks WHERE parent_id IS NULL").get() as { id: string }).id;
    const views = new WorkbenchViews(db, new RuntimeActivity(), { layaEnabled: () => false, layaEndpoint: () => "", layaStatus: () => ({ connected: false }), workspaces: () => [] });
    const { flow, task } = views.task(root)!;
    expect(flow.nodes.map(node => `${node.id}@${node.layer}`)).toEqual(["request@0", "agent:lead@1", "agent:researcher@2", "agent:coder@2", "agent:devops@2", "agent:reviewer@3", "result@4"]);
    expect(flow.edges.map(edge => `${edge.from}>${edge.to}`).sort()).toEqual([
      "agent:coder>agent:reviewer", "agent:devops>agent:reviewer", "agent:lead>agent:coder", "agent:lead>agent:devops", "agent:lead>agent:researcher",
      "agent:researcher>agent:reviewer", "agent:reviewer>result", "request>agent:lead"
    ]);
    expect(task.plan).toMatchObject({ progress: 1 });
  });

  it("lets a team member pull in another agent on its own", async () => {
    const model = teamModel({
      lead: [call("t1", "delegate_team", { tasks: [{ agent_id: "coder", instruction: "Add the migration" }, { agent_id: "reviewer", instruction: "Review it", after: ["coder"] }] }), { content: "Done.", toolCalls: [] }],
      coder: [call("c1", "ask_agent", { agent_id: "database", question: "Which index should the users table get?" }), { content: "Migration added with the index.", toolCalls: [] }],
      reviewer: [call("r1", "ask_agent", { agent_id: "coder", question: "Did you run the migration test?" }), { content: "Approved.", toolCalls: [] }]
    });
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), config);
    await orchestrator.runRoot("Add a users index migration", "lead", false, { approvalMode: "approve" });

    const handoffs = db.connection.prepare("SELECT sender_agent_id || '>' || receiver_agent_id AS h, type FROM agent_messages WHERE type IN ('ask', 'delegate') ORDER BY rowid").all() as Array<{ h: string; type: string }>;
    expect(handoffs.map(row => `${row.type}:${row.h}`)).toEqual(["delegate:lead>coder", "delegate:coder>reviewer", "ask:coder>database", "ask:reviewer>coder"]);

    // The Agent Work feed names who asked whom without repeating the "Consultation request from …" header.
    const root = (db.connection.prepare("SELECT id FROM tasks WHERE parent_id IS NULL").get() as { id: string }).id;
    const views = new WorkbenchViews(db, new RuntimeActivity(), { layaEnabled: () => false, layaEndpoint: () => "", layaStatus: () => ({ connected: false }), workspaces: () => [] });
    expect(views.task(root)!.events.map(event => event.label)).toContain("Asked Database: Which index should the users table get?");
  });

  it("keeps going when one member fails, and tells the reviewer and the lead", async () => {
    const model = teamModel({ lead: [designTeam, { content: "Partly fixed; DevOps could not check the environment.", toolCalls: [] }], devops: [new Error("model timed out")] });
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), config);
    const answer = await orchestrator.runRoot("Fix authentication 500 error", "lead", false, { approvalMode: "approve" });

    expect(answer).toBe("Partly fixed; DevOps could not check the environment.");
    expect(model.calls.find(c => c.agent === "reviewer")!.user).toContain("DevOps did not finish: model timed out");
    expect(model.calls.at(-1)!.user).toContain('"agent":"devops","status":"failed","result":"model timed out"');
  });

  it("stops starting agents once the request's run budget is spent", async () => {
    const model = teamModel({ lead: [designTeam, { content: "Done with what the team had.", toolCalls: [] }] });
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { ...config, maxAgentRunsPerRequest: 2 });
    await orchestrator.runRoot("Fix authentication 500 error", "lead", false, { approvalMode: "approve" });

    // Researcher and Coder use the budget; DevOps and the Reviewer are refused, and the lead hears why.
    expect(model.calls.map(c => c.agent)).toEqual(["lead", "researcher", "coder", "lead"]);
    expect(model.calls.at(-1)!.user).toContain('"agent":"devops","status":"failed","result":"This request already started 2 agent runs, the limit.');
    expect(model.calls.at(-1)!.user).toContain('"agent":"reviewer","status":"failed"');
  });

  it("gives no team suggestion for a question", async () => {
    const model = teamModel({});
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), config);
    await orchestrator.runRoot("Describe this project structure", "lead", true, { approvalMode: "approve" });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].system).not.toContain("Suggested team");
  });
});
