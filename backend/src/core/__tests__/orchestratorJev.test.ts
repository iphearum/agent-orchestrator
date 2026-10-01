import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../persistence/database";
import { AgentDecisionEngine } from "../decision";
import { Orchestrator } from "../orchestrator";
import type { ChatResponse } from "../types";

let dir: string;
let db: AgentDatabase;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-jev-")); db = new AgentDatabase(dir); db.seedAgents(); });
afterEach(() => { db.connection.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const scripted = (turns: ChatResponse[]) => ({ chat: async () => turns.shift() ?? { content: "done", toolCalls: [] } });
const fact = (id: string, target: string): ChatResponse => ({ content: null, toolCalls: [{ id, type: "function", function: { name: "remember_relation", arguments: JSON.stringify({ source_name: "Gateway", source_type: "service", predicate: "uses_port", target_name: target }) } }] });

describe("orchestrator and JEV", () => {
  it("records facts through JEV, links them to the task and traces a replaced value", async () => {
    const model = scripted([fact("c1", "8080"), fact("c2", "9090"), { content: "The gateway now listens on 9090.", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 0, maxDelegationsPerTask: 8, contextRecentMessages: 6 });
    await orchestrator.runRoot("The gateway moved from port 8080 to 9090", "coder", false, { approvalMode: "approve", conversationId: "chat-1" });

    const active = db.connection.prepare("SELECT t.name AS target FROM relations r JOIN entities t ON t.id = r.target_id WHERE r.predicate = 'uses_port' AND r.active = 1").all();
    expect(active).toEqual([{ target: "9090" }]);
    const root = db.connection.prepare("SELECT id FROM tasks WHERE parent_id IS NULL").get() as { id: string };
    expect((db.connection.prepare("SELECT COUNT(*) AS n FROM task_entities WHERE task_id = ?").get(root.id) as { n: number }).n).toBe(3);
    const conflict = db.connection.prepare("SELECT data_json FROM traces WHERE kind = 'jev'").get() as { data_json: string };
    expect(JSON.parse(conflict.data_json)).toMatchObject({ event: "conflict_resolved", predicate: "uses_port" });
    const result = db.connection.prepare("SELECT result_json FROM tool_runs ORDER BY rowid DESC LIMIT 1").get() as { result_json: string };
    expect(JSON.parse(result.result_json)).toMatchObject({ ok: true, outcome: "replaced", replaced_old_values: 1 });
  });
});
