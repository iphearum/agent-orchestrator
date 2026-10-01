import type { DatabaseSync } from "node:sqlite";

// Row shapes read by the workbench views. SQL lives here; view-model rules live in vscode/webviews/views.ts.

export interface TaskRow {
  id: string; number: number; parent_id: string | null; root_id: string; agent_id: string | null;
  title: string; description: string | null; status: string; priority: number; depth: number;
  result: string | null; created_at: string; completed_at: string | null;
}
export interface TraceRow { id: string; conversation_id: string | null; task_id: string; agent_id: string; kind: string; data_json: string; created_at: string; seq: number }
export interface ToolRunRow { id: string; task_id: string; agent_id: string; tool_name: string; arguments_json: string | null; result_json: string | null; status: string | null; created_at: string; seq: number }
export interface AgentMessageRow { id: string; task_id: string; sender_agent_id: string | null; receiver_agent_id: string | null; type: string; payload_json: string | null; created_at: string; seq: number }
export interface PlanStepRow { plan_id: string; objective: string | null; step_id: string | null; position: number | null; description: string | null; status: string | null }
export interface MessageRow { id: string; role: string; agent_id: string | null; content: string; created_at: string }
export interface EntityRow { id: string; name: string; type: string; relation_count: number; data_json?: string | null }
export interface ConversationRow { id: string; title: string; updated_at: string; task_id: string | null }

/** Root tasks are numbered by creation order; the number is display-only (#12). */
const NUMBERED_ROOTS = `SELECT ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS number, id, parent_id, root_id, agent_id, title, description,
  status, priority, depth, result, created_at, completed_at FROM tasks WHERE parent_id IS NULL`;

export class WorkbenchRepository {
  constructor(private readonly db: DatabaseSync) {}

  ping(): boolean { return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined)?.ok === 1; }

  listRootTasks(limit: number): TaskRow[] {
    return this.db.prepare(`SELECT * FROM (${NUMBERED_ROOTS}) ORDER BY number DESC LIMIT ?`).all(limit) as unknown as TaskRow[];
  }

  getRootTask(id: string): TaskRow | undefined {
    return (this.db.prepare(`SELECT * FROM (${NUMBERED_ROOTS}) WHERE id = ?`).get(id) as unknown as TaskRow | undefined) ?? undefined;
  }

  latestRootTaskId(): string | undefined {
    return (this.db.prepare("SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined)?.id;
  }

  /** The root task plus every delegated subtask. */
  taskTree(rootId: string): TaskRow[] {
    return this.db.prepare(`SELECT 0 AS number, id, parent_id, root_id, agent_id, title, description, status, priority, depth, result, created_at, completed_at
      FROM tasks WHERE root_id = ? ORDER BY rowid`).all(rootId) as unknown as TaskRow[];
  }

  traces(rootId: string): TraceRow[] {
    return this.db.prepare(`SELECT t.id, t.conversation_id, t.task_id, t.agent_id, t.kind, t.data_json, t.created_at, t.rowid AS seq
      FROM traces t JOIN tasks k ON k.id = t.task_id WHERE k.root_id = ? ORDER BY t.rowid`).all(rootId) as unknown as TraceRow[];
  }

  toolRuns(rootId: string): ToolRunRow[] {
    return this.db.prepare(`SELECT r.id, r.task_id, r.agent_id, r.tool_name, r.arguments_json, r.result_json, r.status, r.created_at, r.rowid AS seq
      FROM tool_runs r JOIN tasks k ON k.id = r.task_id WHERE k.root_id = ? ORDER BY r.rowid`).all(rootId) as unknown as ToolRunRow[];
  }

  toolRun(id: string): ToolRunRow | undefined {
    return (this.db.prepare(`SELECT id, task_id, agent_id, tool_name, arguments_json, result_json, status, created_at, rowid AS seq
      FROM tool_runs WHERE id = ?`).get(id) as unknown as ToolRunRow | undefined) ?? undefined;
  }

  agentMessages(rootId: string): AgentMessageRow[] {
    return this.db.prepare(`SELECT m.id, m.task_id, m.sender_agent_id, m.receiver_agent_id, m.type, m.payload_json, m.created_at, m.rowid AS seq
      FROM agent_messages m JOIN tasks k ON k.id = m.task_id WHERE k.root_id = ? ORDER BY m.rowid`).all(rootId) as unknown as AgentMessageRow[];
  }

  /** Newest active plan attached to any task of the tree, with its steps in order. */
  activePlan(rootId: string): PlanStepRow[] {
    return this.db.prepare(`SELECT p.id AS plan_id, p.objective, s.id AS step_id, s.position, s.description, s.status
      FROM plans p LEFT JOIN plan_steps s ON s.plan_id = p.id
      WHERE p.id = (SELECT p2.id FROM plans p2 JOIN tasks k ON k.id = p2.task_id WHERE k.root_id = ? AND p2.status IN ('active','completed','failed') ORDER BY CASE WHEN p2.status = 'active' THEN 0 ELSE 1 END, p2.rowid DESC LIMIT 1)
      ORDER BY s.position`).all(rootId) as unknown as PlanStepRow[];
  }

  conversationForTask(rootId: string): string | undefined {
    return (this.db.prepare("SELECT conversation_id FROM traces WHERE task_id = ? AND conversation_id IS NOT NULL ORDER BY rowid LIMIT 1").get(rootId) as { conversation_id: string } | undefined)?.conversation_id;
  }

  latestTaskForConversation(conversationId: string): string | undefined {
    return (this.db.prepare(`SELECT t.task_id FROM traces t JOIN tasks k ON k.id = t.task_id
      WHERE t.conversation_id = ? AND k.parent_id IS NULL ORDER BY t.rowid DESC LIMIT 1`).get(conversationId) as { task_id: string } | undefined)?.task_id;
  }

  conversationMessages(conversationId: string, limit: number): MessageRow[] {
    return (this.db.prepare(`SELECT id, role, agent_id, content, created_at FROM messages
      WHERE conversation_id = ? AND role IN ('user', 'assistant', 'result') ORDER BY rowid DESC LIMIT ?`).all(conversationId, limit) as unknown as MessageRow[]).reverse();
  }

  recentConversations(limit: number): ConversationRow[] {
    return this.db.prepare(`SELECT c.id, c.title, c.updated_at,
      (SELECT t.task_id FROM traces t JOIN tasks k ON k.id = t.task_id WHERE t.conversation_id = c.id AND k.parent_id IS NULL ORDER BY t.rowid DESC LIMIT 1) AS task_id
      FROM conversations c WHERE c.archived_at IS NULL ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`).all(limit) as unknown as ConversationRow[];
  }

  /** Entities the task (and its subtasks) touched or recorded, strongest link first (JEV task_entities). */
  entitiesForTask(rootTaskId: string, limit: number): EntityRow[] {
    return this.db.prepare(`SELECT e.id, e.name, e.type, e.data_json, MAX(te.weight) AS weight,
      (SELECT COUNT(*) FROM relations r WHERE r.active = 1 AND (r.source_id = e.id OR r.target_id = e.id)) AS relation_count
      FROM task_entities te JOIN entities e ON e.id = te.entity_id
      WHERE te.task_id IN (SELECT id FROM tasks WHERE id = ? OR root_id = ?)
      GROUP BY e.id ORDER BY weight DESC, relation_count DESC LIMIT ?`).all(rootTaskId, rootTaskId, limit) as unknown as EntityRow[];
  }

  /** Entities whose name matches any term, with their count of active relations. */
  entitiesMatching(terms: string[], limit: number): EntityRow[] {
    if (!terms.length) return [];
    const where = terms.map(() => "lower(e.name) LIKE ?").join(" OR ");
    return this.db.prepare(`SELECT e.id, e.name, e.type, e.data_json,
      (SELECT COUNT(*) FROM relations r WHERE r.active = 1 AND (r.source_id = e.id OR r.target_id = e.id)) AS relation_count
      FROM entities e WHERE ${where} ORDER BY relation_count DESC, e.created_at DESC LIMIT ?`).all(...terms.map(term => `%${term}%`), limit) as unknown as EntityRow[];
  }

  // ---- workspace-wide reads for the Overview tab

  rootStatusCounts(): Array<{ status: string; count: number }> {
    return this.db.prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE parent_id IS NULL GROUP BY status").all() as unknown as Array<{ status: string; count: number }>;
  }

  /** Root ids of tasks stored as active, to tell interrupted runs apart from running ones. */
  activeRootIds(): string[] {
    return (this.db.prepare("SELECT id FROM tasks WHERE parent_id IS NULL AND status = 'active'").all() as Array<{ id: string }>).map(row => row.id);
  }

  toolRunTotals(): { total: number; failed: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'failed'), 0) AS failed FROM tool_runs").get() as { total: number; failed: number } | undefined;
    return { total: Number(row?.total ?? 0), failed: Number(row?.failed ?? 0) };
  }

  agentTaskCounts(): Map<string, number> {
    const rows = this.db.prepare("SELECT agent_id, COUNT(*) AS count FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id").all() as Array<{ agent_id: string; count: number }>;
    return new Map(rows.map(row => [row.agent_id, Number(row.count)]));
  }

  rootNumbers(): Map<string, number> {
    const rows = this.db.prepare(`SELECT id, number FROM (${NUMBERED_ROOTS})`).all() as Array<{ id: string; number: number }>;
    return new Map(rows.map(row => [row.id, Number(row.number)]));
  }

  recentToolRuns(limit: number): Array<ToolRunRow & { root_id: string }> {
    return this.db.prepare(`SELECT r.id, r.task_id, r.agent_id, r.tool_name, r.arguments_json, r.result_json, r.status, r.created_at, r.rowid AS seq, k.root_id
      FROM tool_runs r JOIN tasks k ON k.id = r.task_id ORDER BY r.rowid DESC LIMIT ?`).all(limit) as unknown as Array<ToolRunRow & { root_id: string }>;
  }

  recentHandoffs(limit: number): Array<AgentMessageRow & { root_id: string }> {
    return this.db.prepare(`SELECT m.id, m.task_id, m.sender_agent_id, m.receiver_agent_id, m.type, m.payload_json, m.created_at, m.rowid AS seq, k.root_id
      FROM agent_messages m JOIN tasks k ON k.id = m.task_id WHERE m.type IN ('delegate', 'ask') ORDER BY m.rowid DESC LIMIT ?`).all(limit) as unknown as Array<AgentMessageRow & { root_id: string }>;
  }

  setTaskDescription(id: string, description: string) {
    this.db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(description, id);
  }

  setTaskStatus(id: string, status: "completed" | "cancelled") {
    this.db.prepare("UPDATE tasks SET status = ?, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?").run(status, id);
  }
}
