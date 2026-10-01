import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "crypto";
import { AgentDefinition, MemoryType, TraceKind } from "../core/types";

export interface TaskRecord { id: string; parentId?: string; rootId: string; ownerAgentId: string; instruction: string; status: string; result?: string; depth: number; }
export interface RelatedConversationContext { conversationId: string; context: string; score: number; }

/** SQLite is the authoritative runtime store. Vector indexes, when added, remain optional projections. */
export class AgentDatabase {
  private readonly db: DatabaseSync;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(path.join(storageDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }

  /** Shared connection for repositories split out of this class. */
  get connection(): DatabaseSync { return this.db; }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, token_count INTEGER, active_context INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(conversation_id) REFERENCES conversations(id));
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, system_prompt TEXT NOT NULL, skills_json TEXT NOT NULL, provider_id TEXT, model TEXT, n8n_link_id TEXT, socket_link_id TEXT, status TEXT DEFAULT 'idle', can_delegate INTEGER DEFAULT 0, laya_profile TEXT NOT NULL DEFAULT 'general', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, schema_json TEXT, risk_level INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS agent_tools (agent_id TEXT NOT NULL, tool_id TEXT NOT NULL, priority REAL DEFAULT 1, PRIMARY KEY(agent_id, tool_id), FOREIGN KEY(agent_id) REFERENCES agents(id), FOREIGN KEY(tool_id) REFERENCES tools(id));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, agent_id TEXT, conversation_id TEXT, type TEXT NOT NULL, content TEXT NOT NULL, importance REAL DEFAULT .5, confidence REAL DEFAULT 1, source_message_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, accessed_at TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, data_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(type, name));
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, predicate TEXT NOT NULL, target_id TEXT NOT NULL, confidence REAL DEFAULT 1, source_message_id TEXT, valid_from TEXT, valid_to TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(source_id) REFERENCES entities(id), FOREIGN KEY(target_id) REFERENCES entities(id));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, agent_id TEXT, parent_id TEXT, root_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, depth INTEGER DEFAULT 0, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, FOREIGN KEY(parent_id) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, objective TEXT, status TEXT DEFAULT 'active', FOREIGN KEY(task_id) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS plan_steps (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL, description TEXT NOT NULL, status TEXT DEFAULT 'pending', result TEXT, FOREIGN KEY(plan_id) REFERENCES plans(id));
      CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, sender_agent_id TEXT, receiver_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT, task_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tool_runs (id TEXT PRIMARY KEY, conversation_id TEXT, task_id TEXT, agent_id TEXT, tool_name TEXT NOT NULL, arguments_json TEXT, result_json TEXT, summary TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, start_message_id TEXT, end_message_id TEXT, summary TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, conversation_id TEXT, task_id TEXT, agent_id TEXT, kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS queue_runs (id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, active, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(conversation_id, active_context, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_id, status);
      CREATE INDEX IF NOT EXISTS idx_queue_runs_status ON queue_runs(status, created_at);
    `);
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!agentColumns.some(column => column.name === "provider_id")) this.db.exec("ALTER TABLE agents ADD COLUMN provider_id TEXT");
    if (!agentColumns.some(column => column.name === "n8n_link_id")) this.db.exec("ALTER TABLE agents ADD COLUMN n8n_link_id TEXT");
    if (!agentColumns.some(column => column.name === "socket_link_id")) this.db.exec("ALTER TABLE agents ADD COLUMN socket_link_id TEXT");
    if (!agentColumns.some(column => column.name === "cli_link_id")) this.db.exec("ALTER TABLE agents ADD COLUMN cli_link_id TEXT");
    // Chat sessions: which agent a conversation belongs to, and whether the user archived it.
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    if (!conversationColumns.some(column => column.name === "agent_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT");
    if (!conversationColumns.some(column => column.name === "archived_at")) this.db.exec("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(archived_at, updated_at)");
    // Chat replies keep a record of how they were produced (steps, thinking, duration) so reopened chats can show it.
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some(column => column.name === "meta_json")) this.db.exec("ALTER TABLE messages ADD COLUMN meta_json TEXT");
    // JEV: which entities a task involved (files read/edited, facts recorded). Same shape as the planned migration 002.
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_entities (task_id TEXT NOT NULL, entity_id TEXT NOT NULL, weight REAL DEFAULT 1.0, PRIMARY KEY (task_id, entity_id));
      CREATE INDEX IF NOT EXISTS idx_task_entities_entity ON task_entities(entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id, predicate, active);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id, active);
      CREATE INDEX IF NOT EXISTS idx_traces_conversation ON traces(conversation_id, task_id);`);
    const toolRunColumns = this.db.prepare("PRAGMA table_info(tool_runs)").all() as Array<{ name: string }>;
    if (!toolRunColumns.some(column => column.name === "task_id")) this.db.exec("ALTER TABLE tool_runs ADD COLUMN task_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tool_runs_task ON tool_runs(task_id, created_at)");
    const version = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined;
    if (!version) this.db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  }

  seedAgents() {
    const defaults: AgentDefinition[] = [
      { id: "lead", name: "Lead", description: "Plans work, delegates subtasks, integrates results.", systemPrompt: "You are the Lead agent. Solve the user's task and integrate specialist results.", skills: ["planning", "architecture", "delegation"], canDelegate: true, layaProfile: "planner" },
      { id: "coder", name: "Coder", description: "Implements and refactors application code.", systemPrompt: "You are a senior software engineer. Produce correct, maintainable code.", skills: ["typescript", "javascript", "backend", "frontend", "coding"], canDelegate: true, layaProfile: "coder" },
      { id: "researcher", name: "Researcher", description: "Investigates information and compares evidence.", systemPrompt: "You are a careful researcher. Separate known facts from assumptions and cite evidence when available.", skills: ["research", "analysis", "documentation"], canDelegate: true, layaProfile: "researcher" },
      { id: "planner", name: "Planner", description: "Breaks objectives into sequenced tasks and keeps plans current.", systemPrompt: "You are a planning specialist. Create clear, ordered steps and identify dependencies and risks.", skills: ["planning", "task decomposition", "strategy", "dependencies"], canDelegate: true, layaProfile: "planner" },
      { id: "database", name: "Database", description: "Database design, SQL, migrations, performance.", systemPrompt: "You are a database engineer specializing in schema design, indexing, migrations and integrity.", skills: ["sql", "sqlite", "postgresql", "database"], canDelegate: true, layaProfile: "coder" },
      { id: "reviewer", name: "Reviewer", description: "Reviews architecture and code for correctness and risks.", systemPrompt: "You are a strict code and architecture reviewer. Identify concrete bugs, risks and missing tests.", skills: ["review", "testing", "security", "quality"], canDelegate: false, layaProfile: "general" },
      { id: "devops", name: "DevOps", description: "Investigates build, deployment, infrastructure, and CI configuration.", systemPrompt: "You are a DevOps specialist. Inspect deployment and infrastructure configuration and explain operational risks.", skills: ["deployment", "infrastructure", "CI/CD", "build systems"], canDelegate: true, layaProfile: "coder" },
      { id: "documenter", name: "Documenter", description: "Writes and maintains clear project and API documentation.", systemPrompt: "You are a technical writer. Produce concise, accurate documentation grounded in the project source.", skills: ["documentation", "technical writing", "API references"], canDelegate: false, layaProfile: "general" }
    ];
    for (const agent of defaults) if (!this.getAgent(agent.id)) this.upsertAgent(agent, false);
    this.db.exec("INSERT OR IGNORE INTO tools(id,name,description,schema_json) VALUES ('list_agents','list_agents','List available agents','{}'),('find_agent','find_agent','Find an agent by capability','{}'),('ask_agent','ask_agent','Ask a focused question','{}'),('delegate_task','delegate_task','Delegate a subtask','{}'),('delegate_team','delegate_team','Run several agents as a team','{}'),('remember','remember','Persist a reusable fact','{}')");
  }

  upsertAgent(agent: AgentDefinition, persist = true) {
    this.db.prepare(`INSERT INTO agents(id,name,description,system_prompt,skills_json,provider_id,model,n8n_link_id,socket_link_id,cli_link_id,status,can_delegate,laya_profile) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,system_prompt=excluded.system_prompt,skills_json=excluded.skills_json,provider_id=excluded.provider_id,model=excluded.model,n8n_link_id=excluded.n8n_link_id,socket_link_id=excluded.socket_link_id,cli_link_id=excluded.cli_link_id,can_delegate=excluded.can_delegate,laya_profile=excluded.laya_profile`).run(agent.id, agent.name, agent.description, agent.systemPrompt, JSON.stringify(agent.skills), agent.providerId ?? null, agent.model ?? null, agent.n8nLinkId ?? null, agent.socketLinkId ?? null, agent.cliLinkId ?? null, agent.status ?? "idle", agent.canDelegate ? 1 : 0, agent.layaProfile ?? "general");
    void persist;
  }

  deleteAgent(id: string) { this.db.prepare("DELETE FROM agents WHERE id=?").run(id); }

  private mapAgent(row: any): AgentDefinition { return { id: row.id, name: row.name, description: row.description, systemPrompt: row.system_prompt, skills: JSON.parse(row.skills_json || "[]"), providerId: row.provider_id ?? undefined, model: row.model ?? undefined, n8nLinkId: row.n8n_link_id ?? undefined, socketLinkId: row.socket_link_id ?? undefined, cliLinkId: row.cli_link_id ?? undefined, status: row.status, canDelegate: Boolean(row.can_delegate), layaProfile: row.laya_profile }; }
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
  latestConversationMessageId(id: string): string | undefined {
    return (this.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role IN ('user','result') ORDER BY rowid DESC LIMIT 1").get(id) as { id: string } | undefined)?.id;
  }
  recentMessages(conversationId: string, limit = 6): string[] {
    const summary = this.db.prepare("SELECT summary FROM summaries WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(conversationId) as { summary: string } | undefined;
    const recent = (this.db.prepare("SELECT role,content FROM messages WHERE conversation_id=? AND active_context=1 ORDER BY created_at DESC, rowid DESC LIMIT ?").all(conversationId, Math.max(1, limit)) as any[]).reverse().map(row => `${row.role}: ${row.content}`);
    let summaryText = summary?.summary;
    if (summaryText) {
      try { summaryText = JSON.parse(summaryText).summary || summaryText; } catch { /* Keep summaries created by older versions readable. */ }
    }
    return [...(summaryText ? [`Conversation summary: ${summaryText}`] : []), ...recent];
  }

  /** Store an extractive structured summary and trim only the active prompt window; raw messages remain intact. */
  compressConversation(conversationId: string, keepRecent = 12) {
    const safeKeep = Math.max(4, Math.min(40, Math.trunc(keepRecent) || 12));
    const rows = this.db.prepare("SELECT id,role,content FROM messages WHERE conversation_id=? AND active_context=1 ORDER BY rowid").all(conversationId) as Array<{ id: string; role: string; content: string }>;
    if (rows.length <= safeKeep) return false;
    const archived = rows.slice(0, rows.length - safeKeep);
    const recentSummary = this.db.prepare("SELECT end_message_id FROM summaries WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1").get(conversationId) as { end_message_id: string | null } | undefined;
    if (recentSummary?.end_message_id === archived[archived.length - 1].id) return false;
    const grouped = new Map<string, string[]>();
    for (const row of archived) {
      const content = row.content.replace(/\s+/g, " ").trim().slice(0, 700);
      if (!content) continue;
      const key = row.role === "user" ? "user_requests" : row.role === "result" || row.role === "assistant" ? "assistant_outcomes" : "events";
      const items = grouped.get(key) || [];
      items.push(content);
      grouped.set(key, items);
    }
    let previous: any = {};
    const priorSummary = this.db.prepare("SELECT summary FROM summaries WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1").get(conversationId) as { summary: string } | undefined;
    try { if (priorSummary) previous = JSON.parse(priorSummary.summary); } catch { previous = { summary: priorSummary?.summary || "" }; }
    const requests = [...(Array.isArray(previous.user_requests) ? previous.user_requests : []), ...(grouped.get("user_requests") || [])].slice(-8);
    const outcomes = [...(Array.isArray(previous.assistant_outcomes) ? previous.assistant_outcomes : []), ...(grouped.get("assistant_outcomes") || [])].slice(-8);
    const events = [...(Array.isArray(previous.events) ? previous.events : []), ...(grouped.get("events") || [])].slice(-4);
    const summary = JSON.stringify({
      summary: [previous.summary, ...[...grouped.values()].flat()].filter(Boolean).slice(-16).join(" | ").slice(-5000),
      user_requests: requests,
      assistant_outcomes: outcomes,
      events
    });
    const insert = this.db.prepare("INSERT INTO summaries(id,conversation_id,start_message_id,end_message_id,summary) VALUES(?,?,?,?,?)");
    insert.run(randomUUID(), conversationId, archived[0].id, archived[archived.length - 1].id, summary);
    this.db.prepare("UPDATE messages SET active_context=0 WHERE conversation_id=? AND id IN (" + archived.map(() => "?").join(",") + ")").run(conversationId, ...archived.map(row => row.id));
    return true;
  }
  createTask(task: { id: string; parentId?: string; rootId: string; ownerAgentId: string; instruction: string; depth: number; status?: string }) { this.db.prepare("INSERT INTO tasks(id,parent_id,root_id,agent_id,title,description,status,depth) VALUES(?,?,?,?,?,?,?,?)").run(task.id, task.parentId ?? null, task.rootId, task.ownerAgentId, task.instruction.slice(0, 160), task.instruction, task.status ?? "active", task.depth); }
  setTaskStatus(id: string, status: string) { this.db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, id); }
  completeTask(id: string, result: string) { this.db.prepare("UPDATE tasks SET status='completed',result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(result, id); }
  failTask(id: string, error: string) { this.db.prepare("UPDATE tasks SET status='blocked',result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(error, id); }
  addMessage(taskId: string, fromAgent: string | null, toAgent: string | null, kind: string, content: string) { this.db.prepare("INSERT INTO agent_messages(id,task_id,sender_agent_id,receiver_agent_id,type,payload_json) VALUES(?,?,?,?,?,?)").run(randomUUID(), taskId, fromAgent, toAgent, kind, JSON.stringify({ content })); }
  remember(agentId: string | null, scope: string, content: string, type: MemoryType = "semantic", conversationId?: string, sourceMessageId?: string) {
    const source = sourceMessageId ?? (conversationId ? (this.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role IN ('user','result') ORDER BY rowid DESC LIMIT 1").get(conversationId) as { id: string } | undefined)?.id : undefined);
    this.db.prepare("INSERT INTO memories(id,agent_id,conversation_id,type,content,source_message_id) VALUES(?,?,?,?,?,?)").run(randomUUID(), scope === "project" ? null : agentId, conversationId ?? null, type, content, source ?? null);
  }
  recentMemories(agentId: string, limit = 8, query = ""): string[] {
    const rows = this.db.prepare("SELECT id,content,importance,confidence,created_at FROM memories WHERE active=1 AND (agent_id=? OR agent_id IS NULL) ORDER BY created_at DESC LIMIT 100").all(agentId) as Array<{ id: string; content: string; importance: number; confidence: number; created_at: string }>;
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])];
    return rows.map(row => {
      const text = row.content.toLowerCase();
      const matches = terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0);
      const score = (matches / Math.max(1, terms.length)) * 2 + (row.importance || .5) * .35 + (row.confidence || 0) * .15;
      return { ...row, score };
    }).filter(row => !terms.length || terms.some(term => row.content.toLowerCase().includes(term))).sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, limit)).map(row => row.content);
  }
  memoriesFromConversations(agentId: string, conversationIds: string[], limit = 6): string[] {
    const ids = [...new Set(conversationIds)].slice(0, 8);
    if (!ids.length) return [];
    return (this.db.prepare(`SELECT content FROM memories WHERE active=1 AND (agent_id=? OR agent_id IS NULL)
      AND conversation_id IN (${ids.map(() => "?").join(",")}) ORDER BY importance DESC,created_at DESC LIMIT ?`)
      .all(agentId, ...ids, Math.max(1, Math.min(20, limit))) as Array<{ content: string }>).map(row => row.content);
  }
  relatedConversationHistory(agentId: string, currentConversationId: string | undefined, query: string, relatedTerms: string[] = [], limit = 3): RelatedConversationContext[] {
    const terms = [...new Set(`${query} ${relatedTerms.join(" ")}`.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 16);
    if (!terms.length) return [];
    const excludesCurrent = currentConversationId ? "c.id<>? AND" : "";
    const match = terms.map(() => "(lower(c.title) LIKE ? OR lower(m.content) LIKE ?)").join(" OR ");
    const params: any[] = [];
    if (currentConversationId) params.push(currentConversationId);
    params.push(agentId, ...terms.flatMap(term => [`%${term}%`, `%${term}%`]));
    const candidates = this.db.prepare(`SELECT c.id AS conversation_id,c.title,c.updated_at,m.role,m.content
      FROM conversations c JOIN messages m ON m.conversation_id=c.id
      WHERE ${excludesCurrent} c.agent_id=? AND m.role IN ('user','result') AND (${match})
      ORDER BY c.updated_at DESC,m.rowid DESC LIMIT 400`).all(...params) as Array<{ conversation_id: string; title: string | null; updated_at: string; role: string; content: string }>;
    const scores = new Map<string, { title: string; score: number; updatedAt: string }>();
    for (const row of candidates) {
      const text = `${row.title || ""} ${row.content}`.toLowerCase();
      const matches = terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
      const candidate = scores.get(row.conversation_id);
      const score = matches + (row.title && terms.some(term => row.title!.toLowerCase().includes(term)) ? 1.5 : 0);
      if (!candidate || score > candidate.score) scores.set(row.conversation_id, { title: row.title || "Untitled chat", score, updatedAt: row.updated_at });
    }
    return [...scores.entries()].sort((a, b) => b[1].score - a[1].score || b[1].updatedAt.localeCompare(a[1].updatedAt))
      .slice(0, Math.max(1, Math.min(6, limit))).map(([conversationId, candidate]) => {
        const rows = this.db.prepare(`SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','result')
          ORDER BY rowid DESC LIMIT 6`).all(conversationId) as Array<{ role: string; content: string }>;
        const transcript = rows.reverse().map(row => `${row.role === "result" ? "assistant" : "user"}: ${row.content.replace(/\s+/g, " ").trim().slice(0, 600)}`);
        return { conversationId, score: candidate.score, context: `Related prior chat (${candidate.title}):\n${transcript.join("\n")}` };
      });
  }
  findEntities(query: string, limit = 8): string[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])];
    if (!terms.length) return [];
    const rows = this.db.prepare("SELECT name,type,data_json,created_at FROM entities ORDER BY created_at DESC LIMIT 500").all() as Array<{ name: string; type: string; data_json: string | null; created_at: string }>;
    return rows.map(row => ({ ...row, score: terms.reduce((n, term) => n + (`${row.name} ${row.type} ${row.data_json || ""}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, limit)).map(row => row.name);
  }
  findKnowledge(query: string, limit = 12): string[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 12);
    if (!terms.length) return [];
    const q = terms.map(() => "(s.name LIKE ? OR t.name LIKE ? OR r.predicate LIKE ?)").join(" OR ");
    const params = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
    const seeds = this.db.prepare(`SELECT id FROM entities WHERE ${terms.map(() => "lower(name) LIKE ?").join(" OR ")} LIMIT 12`)
      .all(...terms.map(term => `%${term}%`)) as Array<{ id: string }>;
    const seedClause = seeds.length ? ` OR r.source_id IN (${seeds.map(() => "?").join(",")}) OR r.target_id IN (${seeds.map(() => "?").join(",")})` : "";
    const seedIds = seeds.map(seed => seed.id);
    const rows = this.db.prepare(`SELECT s.name AS source,predicate,t.name AS target FROM relations r
      JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id
      WHERE r.active=1 AND ((${q})${seedClause})
      ORDER BY r.confidence DESC,r.created_at DESC LIMIT ?`).all(...params, ...seedIds, ...seedIds, limit) as Array<{ source: string; predicate: string; target: string }>;
    return rows.map(row => `${row.source} --${row.predicate}--> ${row.target}`);
  }
  activePlan(taskId: string) { return this.db.prepare("SELECT id,objective,status FROM plans WHERE task_id=? AND status='active' LIMIT 1").get(taskId) as { id: string; objective: string; status: string } | undefined; }
  createPlan(id: string, taskId: string, objective: string) { this.db.prepare("INSERT INTO plans(id,task_id,objective) VALUES(?,?,?)").run(id, taskId, objective); }
  addPlanStep(id: string, planId: string, position: number, description: string) { this.db.prepare("INSERT INTO plan_steps(id,plan_id,position,description) VALUES(?,?,?,?)").run(id, planId, position, description); }
  updatePlanStep(id: string, status: string, result?: string) { this.db.prepare("UPDATE plan_steps SET status=?,result=? WHERE id=?").run(status, result ?? null, id); }
  setPlanStatus(id: string, status: string) { this.db.prepare("UPDATE plans SET status=? WHERE id=?").run(status, id); }
  upsertEntity(id: string, type: string, name: string, data: unknown = {}) {
    const displayName = name.replace(/\s+/g, " ").trim();
    const normalizedName = displayName.toLowerCase().replace(/[.,;:!?]+$/g, "");
    if (!normalizedName) throw new Error("Entity name must not be empty.");
    const incoming = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const existing = this.db.prepare("SELECT id,name,data_json FROM entities WHERE type=? AND lower(name)=? ORDER BY created_at LIMIT 1").get(type, normalizedName) as { id: string; name: string; data_json: string | null } | undefined;
    if (existing) {
      let prior: Record<string, unknown> = {};
      try { const parsed = JSON.parse(existing.data_json || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prior = parsed; } catch { /* Keep valid incoming metadata if older data is malformed. */ }
      const aliases = [...new Set([...(Array.isArray(prior.aliases) ? prior.aliases : []), ...(Array.isArray(incoming.aliases) ? incoming.aliases : []), existing.name, displayName].filter(alias => typeof alias === "string" && alias.toLowerCase() !== normalizedName))];
      const merged = { ...prior, ...incoming, displayName: prior.displayName || incoming.displayName || displayName, aliases };
      this.db.prepare("UPDATE entities SET data_json=? WHERE id=?").run(JSON.stringify(merged), existing.id);
      return existing.id;
    }
    this.db.prepare("INSERT INTO entities(id,type,name,data_json) VALUES(?,?,?,?)").run(id, type, normalizedName, JSON.stringify({ ...incoming, displayName: incoming.displayName || displayName, aliases: Array.isArray(incoming.aliases) ? incoming.aliases : [] }));
    return id;
  }
  relate(id: string, sourceId: string, predicate: string, targetId: string, confidence = 1) { this.db.prepare("INSERT OR REPLACE INTO relations(id,source_id,predicate,target_id,confidence) VALUES(?,?,?,?,?)").run(id, sourceId, predicate, targetId, confidence); }
  upsertRelation(sourceId: string, predicate: string, targetId: string, confidence = 1, sourceMessageId?: string) {
    const safeConfidence = Math.max(0, Math.min(1, confidence));
    const singleValued = new Set(["uses_port", "database", "owned_by", "runs_on"]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const identical = this.db.prepare("SELECT id FROM relations WHERE source_id=? AND predicate=? AND target_id=? AND active=1 ORDER BY created_at DESC LIMIT 1").get(sourceId, predicate, targetId) as { id: string } | undefined;
      if (identical) {
        this.db.prepare("UPDATE relations SET confidence=MIN(1.0,MAX(confidence,?)+0.05),source_message_id=COALESCE(source_message_id,?) WHERE id=?").run(safeConfidence, sourceMessageId ?? null, identical.id);
        this.db.exec("COMMIT");
        return identical.id;
      }
      if (singleValued.has(predicate)) this.db.prepare("UPDATE relations SET active=0,valid_to=CURRENT_TIMESTAMP WHERE source_id=? AND predicate=? AND active=1").run(sourceId, predicate);
      const id = randomUUID();
      this.db.prepare("INSERT INTO relations(id,source_id,predicate,target_id,confidence,source_message_id,valid_from,active) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,1)").run(id, sourceId, predicate, targetId, safeConfidence, sourceMessageId ?? null);
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recordToolRun(conversationId: string | undefined, taskId: string, agentId: string, name: string, args: unknown, result: string, status = "completed") {
    const id = randomUUID();
    this.db.prepare("INSERT INTO tool_runs(id,conversation_id,task_id,agent_id,tool_name,arguments_json,result_json,status) VALUES(?,?,?,?,?,?,?,?)").run(id, conversationId ?? null, taskId, agentId, name, JSON.stringify(args), result, status);
    return id;
  }
  toolRunResult(id: string): string | undefined { return (this.db.prepare("SELECT result_json FROM tool_runs WHERE id=?").get(id) as { result_json: string } | undefined)?.result_json; }
  recentToolRunRefs(conversationId: string | undefined, limit = 5): Array<{ id: string; tool_name: string }> {
    if (!conversationId) return [];
    return this.db.prepare("SELECT id,tool_name FROM tool_runs WHERE conversation_id=? AND tool_name<>'expand_tool_result' ORDER BY rowid DESC LIMIT ?")
      .all(conversationId, Math.max(1, Math.min(10, Math.trunc(limit) || 5))) as Array<{ id: string; tool_name: string }>;
  }
  trace(conversationId: string | undefined, taskId: string, agentId: string, kind: TraceKind, data: unknown) { this.db.prepare("INSERT INTO traces(id,conversation_id,task_id,agent_id,kind,data_json) VALUES(?,?,?,?,?,?)").run(randomUUID(), conversationId ?? null, taskId, agentId, kind, JSON.stringify(data)); }
  saveQueueRun(run: { id: string; label: string; status: string; error?: string }) { this.db.prepare("INSERT INTO queue_runs(id,label,status,error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=CURRENT_TIMESTAMP").run(run.id, run.label, run.status, run.error ?? null); }
  markInterruptedQueueRuns() { this.db.prepare("UPDATE queue_runs SET status='failed',error='Extension host restarted before this task completed.',updated_at=CURRENT_TIMESTAMP WHERE status IN ('queued','running')").run(); }
  recentQueueRuns(limit = 30) { return this.db.prepare("SELECT id,label,status,error,created_at,updated_at FROM queue_runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Math.trunc(limit) || 30))) as Array<{ id: string; label: string; status: string; error: string | null; created_at: string; updated_at: string }>; }
  monitorSnapshot() {
    const taskCounts = this.db.prepare("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status").all() as Array<{ status: string; count: number }>;
    const traces = (this.db.prepare("SELECT id,task_id,agent_id,kind,data_json,created_at FROM traces ORDER BY rowid DESC LIMIT 30").all() as any[]).map(row => ({ ...row, data: this.safeJson(row.data_json) }));
    const messages = (this.db.prepare("SELECT id,task_id,sender_agent_id,receiver_agent_id,type,payload_json,created_at FROM agent_messages ORDER BY rowid DESC LIMIT 20").all() as any[]).map(row => {
      const payload = this.safeJson(row.payload_json);
      if (payload && typeof payload === "object" && typeof payload.content === "string") payload.content = payload.content.slice(0, 1000);
      return { ...row, payload };
    });
    const tasks = (this.db.prepare(`SELECT id,parent_id,root_id,agent_id,title,description,status,priority,depth,result,created_at,completed_at
      FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT 100`).all() as any[]).map(row => ({
        ...row,
        description: String(row.description || "").slice(0, 1800),
        result: row.result ? String(row.result).slice(0, 1800) : row.result
      }));
    const planRows = this.db.prepare(`SELECT p.id,p.task_id,p.objective,p.status,s.id AS step_id,s.position,s.description AS step_description,s.status AS step_status,s.result AS step_result
      FROM plans p LEFT JOIN plan_steps s ON s.plan_id=p.id
      ORDER BY p.rowid DESC,s.position ASC LIMIT 250`).all() as any[];
    const plansById = new Map<string, any>();
    for (const row of planRows) {
      let plan = plansById.get(row.id);
      if (!plan) {
        plan = { id: row.id, taskId: row.task_id, objective: row.objective, status: row.status, steps: [] };
        plansById.set(row.id, plan);
      }
      if (row.step_id) plan.steps.push({ id: row.step_id, position: row.position, description: String(row.step_description || "").slice(0, 800), status: row.step_status, result: row.step_result ? String(row.step_result).slice(0, 800) : row.step_result });
    }
    const toolRuns = (this.db.prepare(`SELECT id,task_id,agent_id,tool_name,arguments_json,result_json,status,created_at
      FROM tool_runs ORDER BY rowid DESC LIMIT 60`).all() as any[]).map(row => ({
        id: row.id,
        taskId: row.task_id,
        agentId: row.agent_id,
        name: row.tool_name,
        arguments: this.monitorToolArguments(row.arguments_json || "{}"),
        result: String(row.result_json || "").slice(0, 900),
        status: row.status,
        createdAt: row.created_at
      }));
    const knowledge = this.db.prepare(`SELECT s.name AS source,r.predicate,t.name AS target,r.confidence,r.created_at
      FROM relations r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id
      WHERE r.active=1 ORDER BY r.created_at DESC LIMIT 40`).all() as any[];
    const memories = (this.db.prepare(`SELECT id,agent_id,type,content,importance,confidence,created_at
      FROM memories WHERE active=1 ORDER BY created_at DESC LIMIT 30`).all() as any[]).map(row => ({ ...row, content: String(row.content || "").slice(0, 1200) }));
    return {
      agents: this.listAgents(), taskCounts, tasks,
      plans: [...plansById.values()], traces,
      messages,
      toolRuns, knowledge, memories, queue: this.recentQueueRuns(12)
    };
  }
  private monitorToolArguments(value: string): Record<string, unknown> {
    let parsed: unknown = this.safeJson(value);
    if (typeof parsed === "string") parsed = this.safeJson(parsed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === "content") {
        safe.contentChars = typeof item === "string" ? item.length : 0;
      } else if (typeof item === "string" && item.length > 500) {
        safe[key] = `${item.slice(0, 500)}…`;
      } else {
        safe[key] = item;
      }
    }
    return safe;
  }
  private safeJson(value: string) { try { return JSON.parse(value); } catch { return value; } }
}
