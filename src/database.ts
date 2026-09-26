import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "crypto";
import { AgentDefinition, MemoryType, TraceKind } from "./types";

export interface TaskRecord { id: string; parentId?: string; rootId: string; ownerAgentId: string; instruction: string; status: string; result?: string; depth: number; }

/** SQLite is the authoritative runtime store. Vector indexes, when added, remain optional projections. */
export class AgentDatabase {
  private readonly db: DatabaseSync;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(path.join(storageDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER, active_context INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(conversation_id) REFERENCES conversations(id));
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, system_prompt TEXT NOT NULL, skills_json TEXT NOT NULL, model TEXT, status TEXT DEFAULT 'idle', can_delegate INTEGER DEFAULT 0, laya_profile TEXT NOT NULL DEFAULT 'general', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, schema_json TEXT, risk_level INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS agent_tools (agent_id TEXT NOT NULL, tool_id TEXT NOT NULL, priority REAL DEFAULT 1, PRIMARY KEY(agent_id, tool_id), FOREIGN KEY(agent_id) REFERENCES agents(id), FOREIGN KEY(tool_id) REFERENCES tools(id));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT, conversation_id TEXT, type TEXT NOT NULL, content TEXT NOT NULL, importance REAL DEFAULT .5, confidence REAL DEFAULT 1, source_message_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, accessed_at TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, data_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(type, name));
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, predicate TEXT NOT NULL, target_id TEXT NOT NULL, confidence REAL DEFAULT 1, source_message_id TEXT, valid_from TEXT, valid_to TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(source_id) REFERENCES entities(id), FOREIGN KEY(target_id) REFERENCES entities(id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, agent_id TEXT, parent_id TEXT, root_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, depth INTEGER DEFAULT 0, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, FOREIGN KEY(parent_id) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, objective TEXT, status TEXT DEFAULT 'active', FOREIGN KEY(task_id) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS plan_steps (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL, description TEXT NOT NULL, status TEXT DEFAULT 'pending', result TEXT, FOREIGN KEY(plan_id) REFERENCES plans(id));
      CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, sender_agent_id TEXT, receiver_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT, task_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tool_runs (id TEXT PRIMARY KEY, conversation_id TEXT, agent_id TEXT, tool_name TEXT NOT NULL, arguments_json TEXT, result_json TEXT, summary TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, start_message_id TEXT, end_message_id TEXT, summary TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, conversation_id TEXT, task_id TEXT, agent_id TEXT, kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, active, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(conversation_id, active_context, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_id, status);
    `);
    const version = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined;
    if (!version) this.db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  }

  seedAgents() {
    if (this.listAgents().length) return;
    const defaults: AgentDefinition[] = [
      { id: "lead", name: "Lead", description: "Plans work, delegates subtasks, integrates results.", systemPrompt: "You are the Lead agent. Solve the user's task and integrate specialist results.", skills: ["planning", "architecture", "delegation"], canDelegate: true, layaProfile: "planner" },
      { id: "coder", name: "Coder", description: "Implements and refactors application code.", systemPrompt: "You are a senior software engineer. Produce correct, maintainable code.", skills: ["typescript", "javascript", "backend", "frontend", "coding"], canDelegate: true, layaProfile: "coder" },
      { id: "researcher", name: "Researcher", description: "Investigates information and compares evidence.", systemPrompt: "You are a careful researcher. Separate known facts from assumptions and cite evidence when available.", skills: ["research", "analysis", "documentation"], canDelegate: true, layaProfile: "researcher" },
      { id: "database", name: "Database", description: "Database design, SQL, migrations, performance.", systemPrompt: "You are a database engineer specializing in schema design, indexing, migrations and integrity.", skills: ["sql", "sqlite", "postgresql", "database"], canDelegate: true, layaProfile: "coder" },
      { id: "reviewer", name: "Reviewer", description: "Reviews architecture and code for correctness and risks.", systemPrompt: "You are a strict code and architecture reviewer. Identify concrete bugs, risks and missing tests.", skills: ["review", "testing", "security", "quality"], canDelegate: false, layaProfile: "general" }
    ];
    for (const agent of defaults) this.upsertAgent(agent, false);
    this.db.exec("INSERT OR IGNORE INTO tools(id,name,description,schema_json) VALUES ('list_agents','list_agents','List available agents','{}'),('find_agent','find_agent','Find an agent by capability','{}'),('ask_agent','ask_agent','Ask a focused question','{}'),('delegate_task','delegate_task','Delegate a subtask','{}'),('remember','remember','Persist a reusable fact','{}')");
  }

  upsertAgent(agent: AgentDefinition, persist = true) {
    this.db.prepare(`INSERT INTO agents(id,name,description,system_prompt,skills_json,model,status,can_delegate,laya_profile) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,system_prompt=excluded.system_prompt,skills_json=excluded.skills_json,model=excluded.model,can_delegate=excluded.can_delegate,laya_profile=excluded.laya_profile`).run(agent.id, agent.name, agent.description, agent.systemPrompt, JSON.stringify(agent.skills), agent.model ?? null, agent.status ?? "idle", agent.canDelegate ? 1 : 0, agent.layaProfile ?? "general");
    void persist;
  }

  deleteAgent(id: string) { this.db.prepare("DELETE FROM agents WHERE id=?").run(id); }

  private mapAgent(row: any): AgentDefinition { return { id: row.id, name: row.name, description: row.description, systemPrompt: row.system_prompt, skills: JSON.parse(row.skills_json || "[]"), model: row.model ?? undefined, status: row.status, canDelegate: Boolean(row.can_delegate), layaProfile: row.laya_profile }; }
  listAgents(): AgentDefinition[] { return (this.db.prepare("SELECT * FROM agents ORDER BY name").all() as any[]).map(row => this.mapAgent(row)); }
  getAgent(id: string): AgentDefinition | undefined { const row = this.db.prepare("SELECT * FROM agents WHERE id=?").get(id); return row ? this.mapAgent(row) : undefined; }
  findAgents(query: string): AgentDefinition[] { const q = query.toLowerCase(); return this.listAgents().map(agent => ({ agent, score: (agent.name.toLowerCase().includes(q) ? 3 : 0) + (agent.description.toLowerCase().includes(q) ? 2 : 0) + agent.skills.filter(skill => skill.toLowerCase().includes(q) || q.includes(skill.toLowerCase())).length * 3 })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.agent); }

  createConversation(id: string, title: string) { this.db.prepare("INSERT INTO conversations(id,title) VALUES(?,?)").run(id, title.trim().slice(0, 120) || "New conversation"); }
  hasConversation(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM conversations WHERE id=? LIMIT 1").get(id)); }
  addConversationMessage(id: string, conversationId: string, agentId: string | null, role: string, content: string, active = 1) {
    this.db.prepare("INSERT INTO messages(id,conversation_id,agent_id,role,content,active_context) VALUES(?,?,?,?,?,?)").run(id, conversationId, agentId, role, content, active);
    this.db.prepare("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(conversationId);
  }
  listConversations(limit = 100) {
    const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit) || 100));
    return this.db.prepare(`SELECT c.id,c.title,c.created_at,c.updated_at,
      COALESCE((SELECT m.content FROM messages m WHERE m.conversation_id=c.id AND m.role IN ('user','result') ORDER BY m.rowid DESC LIMIT 1),c.title) AS preview
      FROM conversations c ORDER BY c.updated_at DESC,c.rowid DESC LIMIT ?`).all(safeLimit) as Array<{ id: string; title: string; created_at: string; updated_at: string; preview: string }>;
  }
  conversationMessages(id: string) {
    return this.db.prepare("SELECT role,agent_id,content,created_at FROM messages WHERE conversation_id=? AND role IN ('user','result') ORDER BY rowid").all(id) as Array<{ role: string; agent_id: string | null; content: string; created_at: string }>;
  }
  recentMessages(conversationId: string, limit = 6): string[] { return (this.db.prepare("SELECT role,content FROM messages WHERE conversation_id=? AND active_context=1 ORDER BY created_at DESC, rowid DESC LIMIT ?").all(conversationId, limit) as any[]).reverse().map(row => `${row.role}: ${row.content}`); }
  createTask(task: { id: string; parentId?: string; rootId: string; ownerAgentId: string; instruction: string; depth: number }) { this.db.prepare("INSERT INTO tasks(id,parent_id,root_id,agent_id,title,description,status,depth) VALUES(?,?,?,?,?,?,?,?)").run(task.id, task.parentId ?? null, task.rootId, task.ownerAgentId, task.instruction.slice(0, 160), task.instruction, "active", task.depth); }
  completeTask(id: string, result: string) { this.db.prepare("UPDATE tasks SET status='completed',result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(result, id); }
  failTask(id: string, error: string) { this.db.prepare("UPDATE tasks SET status='blocked',result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(error, id); }
  addMessage(taskId: string, fromAgent: string | null, toAgent: string | null, kind: string, content: string) { this.db.prepare("INSERT INTO agent_messages(id,task_id,sender_agent_id,receiver_agent_id,type,payload_json) VALUES(?,?,?,?,?,?)").run(randomUUID(), taskId, fromAgent, toAgent, kind, JSON.stringify({ content })); }
  remember(agentId: string | null, scope: string, content: string, type: MemoryType = "semantic", conversationId?: string) { this.db.prepare("INSERT INTO memories(id,agent_id,conversation_id,type,content) VALUES(?,?,?,?,?)").run(randomUUID(), scope === "project" ? null : agentId, conversationId ?? null, type, content); }
  recentMemories(agentId: string, limit = 8): string[] { return (this.db.prepare("SELECT content FROM memories WHERE active=1 AND (agent_id=? OR agent_id IS NULL) ORDER BY created_at DESC LIMIT ?").all(agentId, limit) as any[]).map(row => row.content); }
  findEntities(query: string, limit = 8): string[] { const q = `%${query}%`; return (this.db.prepare("SELECT name FROM entities WHERE name LIKE ? ORDER BY created_at DESC LIMIT ?").all(q, limit) as any[]).map(row => row.name); }
  activePlan(taskId: string) { return this.db.prepare("SELECT id,objective,status FROM plans WHERE task_id=? AND status='active' LIMIT 1").get(taskId) as { id: string; objective: string; status: string } | undefined; }
  createPlan(id: string, taskId: string, objective: string) { this.db.prepare("INSERT INTO plans(id,task_id,objective) VALUES(?,?,?)").run(id, taskId, objective); }
  addPlanStep(id: string, planId: string, position: number, description: string) { this.db.prepare("INSERT INTO plan_steps(id,plan_id,position,description) VALUES(?,?,?,?)").run(id, planId, position, description); }
  updatePlanStep(id: string, status: string, result?: string) { this.db.prepare("UPDATE plan_steps SET status=?,result=? WHERE id=?").run(status, result ?? null, id); }
  upsertEntity(id: string, type: string, name: string, data: unknown = {}) { this.db.prepare("INSERT INTO entities(id,type,name,data_json) VALUES(?,?,?,?) ON CONFLICT(type,name) DO UPDATE SET data_json=excluded.data_json").run(id, type, name, JSON.stringify(data)); }
  relate(id: string, sourceId: string, predicate: string, targetId: string, confidence = 1) { this.db.prepare("INSERT OR REPLACE INTO relations(id,source_id,predicate,target_id,confidence) VALUES(?,?,?,?,?)").run(id, sourceId, predicate, targetId, confidence); }
  recordToolRun(conversationId: string | undefined, agentId: string, name: string, args: unknown, result: string, status = "completed") { this.db.prepare("INSERT INTO tool_runs(id,conversation_id,agent_id,tool_name,arguments_json,result_json,status) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), conversationId ?? null, agentId, name, JSON.stringify(args), result, status); }
  trace(conversationId: string | undefined, taskId: string, agentId: string, kind: TraceKind, data: unknown) { this.db.prepare("INSERT INTO traces(id,conversation_id,task_id,agent_id,kind,data_json) VALUES(?,?,?,?,?,?)").run(randomUUID(), conversationId ?? null, taskId, agentId, kind, JSON.stringify(data)); }
}
