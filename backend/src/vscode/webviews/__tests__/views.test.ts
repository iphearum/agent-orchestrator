import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../../persistence/database";
import { RuntimeActivity } from "../../../core/activity";
import { WorkbenchViews } from "../views";

let dir: string;
let db: AgentDatabase;
let activity: RuntimeActivity;
let views: WorkbenchViews;

const host = { layaEnabled: () => true, layaEndpoint: () => "http://localhost:9000/v1/systemone", layaStatus: () => ({ connected: false }), workspaces: () => [{ key: "file:///repo", name: "AI Gateway" }] };

/** Records a finished delegated run the same way the orchestrator does. */
function seedRun() {
  db.createConversation("conv-1", "Debug auth 500 error");
  db.addConversationMessage("m1", "conv-1", null, "user", "Fix the authentication 500 error");
  db.createTask({ id: "root", rootId: "root", ownerAgentId: "lead", instruction: "Fix the authentication 500 error on /api/auth/login", depth: 0 });
  db.trace("conv-1", "root", "lead", "routing", { source: "laya", agent: { value: "lead", confidence: 0.96 } });
  db.addMessage("root", "lead", "coder", "delegate", "Inspect src/auth/login.py");
  db.createTask({ id: "child", parentId: "root", rootId: "root", ownerAgentId: "coder", instruction: "Inspect src/auth/login.py", depth: 1 });
  db.recordToolRun("conv-1", "child", "coder", "read_file", { path: "src/auth/login.py" }, "{\"ok\":true}");
  db.recordToolRun("conv-1", "child", "coder", "write_file", { path: "src/auth/login.py", content: "a\nb\nc" }, "{\"ok\":true}");
  db.recordToolRun("conv-1", "child", "coder", "run_command", { command: "pytest -v" }, JSON.stringify({ exitCode: 0, stdout: "t.py::test_ok PASSED\n==== 1 passed in 0.50s ====", stderr: "" }));
  db.completeTask("child", "Added the null check.");
  db.addMessage("child", "coder", "lead", "response", "Added the null check.");
  db.createPlan("plan-1", "root", "Fix login");
  db.addPlanStep("s1", "plan-1", 0, "Find cause");
  db.addPlanStep("s2", "plan-1", 1, "Fix it");
  db.updatePlanStep("s1", "completed");
  db.completeTask("root", "The login bug is fixed.");
  db.addConversationMessage("m2", "conv-1", "lead", "result", "The login bug is fixed.");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workbench-views-"));
  db = new AgentDatabase(dir);
  db.seedAgents();
  activity = new RuntimeActivity();
  views = new WorkbenchViews(db, activity, host);
});

afterEach(() => {
  db.connection.close();
  // On Windows the SQLite/WAL files can stay locked briefly after close; a leftover temp dir is harmless.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup */ }
});

describe("WorkbenchViews", () => {
  it("builds the task panel from a stored run", () => {
    seedRun();
    const bundle = views.task("root")!;
    expect(bundle.task).toMatchObject({ number: 1, status: "completed", running: false, canComplete: false, conversationId: "conv-1" });
    expect(bundle.task.assignees.map(a => a.agent.id)).toEqual(["lead", "coder"]);
    expect(bundle.task.plan).toMatchObject({ progress: 0.5 });

    // Flow: request → lead → coder → result (the result is drawn from the end of the hand-off chain)
    expect(bundle.flow.nodes.map(n => [n.id, n.layer])).toEqual([["request", 0], ["agent:lead", 1], ["agent:coder", 2], ["result", 3]]);
    expect(bundle.flow.edges.map(e => `${e.from}>${e.to}`)).toEqual(["request>agent:lead", "agent:lead>agent:coder", "agent:coder>result"]);

    const labels = bundle.events.map(e => e.label);
    expect(labels[0]).toContain("Laya routed the request (96% confidence)");
    expect(labels).toContain("Read src/auth/login.py.");
    expect(bundle.events.at(-1)?.status).toBe("task_completed");

    expect(bundle.files).toEqual([expect.objectContaining({ path: "src/auth/login.py", additions: 3 })]);
    expect(bundle.tests).toMatchObject({ passed: 1, failed: 0, durationS: 0.5 });
    expect(bundle.messages.map(m => m.role)).toEqual(["user", "result"]);
    expect(bundle.metrics).toMatchObject({ toolRuns: 3, delegations: 1, layaDecisions: 1 });
  });

  it("does not repeat the final answer when it was already the last message", () => {
    db.createTask({ id: "solo", rootId: "solo", ownerAgentId: "coder", instruction: "Fix login", depth: 0 });
    db.addMessage("solo", "coder", null, "assistant", "Fixed the null check.");
    db.completeTask("solo", "Fixed the null check.");
    const labels = views.task("solo")!.events.map(e => e.label);
    expect(labels.filter(label => label === "Fixed the null check.")).toHaveLength(1);
    expect(labels.at(-1)).toBe("Task completed.");
  });

  it("marks live runs from activity, not from the stored status", () => {
    seedRun();
    activity.handle({ type: "start", agentId: "coder", text: "", rootTaskId: "root" });
    const bundle = views.task("root")!;
    expect(bundle.task.running).toBe(true);
    expect(bundle.task.canComplete).toBe(false);
    expect(bundle.events.at(-1)).toMatchObject({ kind: "live", status: "running" });
    expect(views.health()).toMatchObject({ agentsRunning: 1, tasksActive: 1, laya: { status: "unknown" }, sqlite: { status: "connected" } });
  });

  it("lists tasks and conversations for the sidebar", () => {
    seedRun();
    const sidebar = views.sidebar();
    expect(sidebar.tasks).toEqual([expect.objectContaining({ id: "root", number: 1, status: "completed" })]);
    expect(sidebar.conversations[0]).toMatchObject({ id: "conv-1", taskId: "root" });
    expect(sidebar.agents.find(a => a.id === "coder")?.state).toBe("idle");
  });

  it("summarises the workspace for the Overview tab", () => {
    seedRun();
    db.createTask({ id: "stale", rootId: "stale", ownerAgentId: "coder", instruction: "Left running when VS Code closed", depth: 0 });
    const overview = views.overview();
    expect(overview.counts).toMatchObject({ total: 2, completed: 1, running: 0, interrupted: 1 });
    expect(overview.toolRuns).toEqual({ total: 3, failed: 0 });
    expect(overview.agents.find(agent => agent.id === "coder")?.taskCount).toBe(2);
    expect(overview.recentTasks.map(task => task.number)).toEqual([2, 1]);
    // Newest first, each linked to its root task; delegations appear once, not also as tool runs.
    expect(overview.activity[0]).toMatchObject({ taskId: "root", taskNumber: 1 });
    expect(overview.activity.filter(event => event.kind === "handoff")).toHaveLength(1);
  });

  it("reports Laya as not configured when no endpoint is set", () => {
    const bare = new WorkbenchViews(db, activity, { ...host, layaEndpoint: () => "" });
    expect(bare.health().laya.status).toBe("unconfigured");
  });

  it("refuses to close a running task and updates descriptions", () => {
    seedRun();
    db.createTask({ id: "root2", rootId: "root2", ownerAgentId: "lead", instruction: "Second task", depth: 0 });
    activity.handle({ type: "start", agentId: "lead", text: "", rootTaskId: "root2" });
    expect(() => views.updateTask("root2", { status: "completed" })).toThrow("still running");
    expect(views.updateTask("root2", { description: "Clarified" }).description).toBe("Clarified");
    expect(views.task("root2")!.task.number).toBe(2);
  });
});
