import type { DatabaseSync } from "node:sqlite";

/** A chat session is a conversation row, owned by one agent, optionally archived. */
export interface SessionSummary {
  id: string;
  title: string;
  agentId: string | null;
  updatedAt: string;
  archived: boolean;
  preview: string;
  turns: number;
}

/** One step of a reply as the chat showed it live: a run event without its (possibly large) tool output. */
export interface ReplyStep { type: "start" | "delegate" | "tool" | "progress"; agentId?: string; toolName?: string; toolCallId?: string; phase?: string; path?: string; text?: string; targetAgentId?: string; delegateMode?: string }

/** How a reply was produced, saved with it so a reopened chat shows the same "Worked for", steps and thinking. */
export interface ReplyTrace { version: 1; durationMs: number; failed?: boolean; steps: ReplyStep[]; thinking: Array<{ agentId: string; text: string }> }

export interface SessionMessage { id: string; role: "user" | "result"; agentId: string | null; text: string; at: string; trace?: ReplyTrace }

const MAX_STEPS = 400;
const MAX_THINKING_CHARS = 20_000;

/** Keep only what the chat renders, within size limits: step text is short labels, never tool results. */
export function boundedTrace(trace: ReplyTrace): ReplyTrace {
  const clip = (text: unknown, max: number) => typeof text === "string" && text ? text.slice(0, max) : undefined;
  return {
    version: 1,
    durationMs: Math.max(0, Math.round(Number(trace.durationMs) || 0)),
    ...(trace.failed ? { failed: true } : {}),
    steps: trace.steps.slice(-MAX_STEPS).map(step => ({
      type: step.type, agentId: clip(step.agentId, 80), toolName: clip(step.toolName, 120), toolCallId: clip(step.toolCallId, 120),
      phase: clip(step.phase, 20), path: clip(step.path, 500),
      // A hand-off's answer is kept longer (it is shown in its "Answer" section); other step text is a short label.
      text: clip(step.text, step.type === "tool" && (step.toolName === "ask_agent" || step.toolName === "delegate_task" || step.toolName === "delegate_team") ? 1200 : 300),
      targetAgentId: clip(step.targetAgentId, 80), delegateMode: clip(step.delegateMode, 20)
    })),
    thinking: trace.thinking.filter(item => item.text).slice(0, 12).map(item => ({ agentId: item.agentId.slice(0, 80), text: item.text.slice(-MAX_THINKING_CHARS) }))
  };
}

const parseTrace = (json: string | null): ReplyTrace | undefined => {
  if (!json) return undefined;
  try { const trace = JSON.parse(json); return trace?.version === 1 && Array.isArray(trace.steps) ? trace : undefined; } catch { return undefined; }
};

type Row = { id: string; title: string | null; agent_id: string | null; updated_at: string; archived_at: string | null; preview: string | null; turns: number };

const iso = (value: string | null | undefined) => !value ? "" : value.includes("T") ? value : `${value.replace(" ", "T")}Z`;

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Newest first. Archived and active sessions are listed separately. */
  list(options: { archived: boolean; limit?: number }): SessionSummary[] {
    const rows = this.db.prepare(`SELECT c.id, c.title, c.agent_id, c.updated_at, c.archived_at,
        (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'result') ORDER BY m.rowid DESC LIMIT 1) AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
      FROM conversations c
      WHERE ${options.archived ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL"}
      ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`).all(Math.max(1, Math.min(500, options.limit ?? 200))) as unknown as Row[];
    return rows.map(row => this.summary(row));
  }

  get(id: string): SessionSummary | undefined {
    const row = this.db.prepare(`SELECT c.id, c.title, c.agent_id, c.updated_at, c.archived_at, NULL AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
      FROM conversations c WHERE c.id = ?`).get(id) as unknown as Row | undefined;
    return row ? this.summary(row) : undefined;
  }

  /** What the user said and the final answers; intermediate agent chatter stays in the task view. */
  messages(id: string, limit = 200): SessionMessage[] {
    const rows = this.db.prepare(`SELECT id, role, agent_id, content, created_at, meta_json FROM messages
      WHERE conversation_id = ? AND role IN ('user', 'result') ORDER BY rowid DESC LIMIT ?`).all(id, limit) as Array<{ id: string; role: "user" | "result"; agent_id: string | null; content: string; created_at: string; meta_json: string | null }>;
    return rows.reverse().map(row => {
      const trace = row.role === "result" ? parseTrace(row.meta_json) : undefined;
      return { id: row.id, role: row.role, agentId: row.agent_id, text: row.content, at: iso(row.created_at), ...(trace ? { trace } : {}) };
    });
  }

  /** Marks where a run starts, so its record attaches to that run's answer and never to an older one. */
  lastMessageRowid(conversationId: string): number {
    return Number((this.db.prepare("SELECT MAX(rowid) AS id FROM messages WHERE conversation_id = ?").get(conversationId) as { id: number | null } | undefined)?.id ?? 0);
  }

  /** Attach the record to the answer the run wrote. Returns false when the run wrote no answer after `afterRowid`. */
  saveReplyTrace(conversationId: string, afterRowid: number, trace: ReplyTrace): boolean {
    const row = this.db.prepare("SELECT rowid AS id FROM messages WHERE conversation_id = ? AND role = 'result' AND rowid > ? ORDER BY rowid DESC LIMIT 1").get(conversationId, afterRowid) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare("UPDATE messages SET meta_json = ? WHERE rowid = ?").run(JSON.stringify(boundedTrace(trace)), row.id);
    return true;
  }

  /** A run that failed wrote no answer: keep its error and steps for display only (active_context = 0, so agents never see it). */
  addFailedReply(id: string, conversationId: string, agentId: string | null, error: string, trace: ReplyTrace) {
    this.db.prepare("INSERT INTO messages(id, conversation_id, agent_id, role, content, active_context, meta_json) VALUES (?, ?, ?, 'result', ?, 0, ?)")
      .run(id, conversationId, agentId, error.slice(0, 4000), JSON.stringify(boundedTrace({ ...trace, failed: true })));
  }

  /** Create the session before its first run, so the orchestrator continues it instead of starting a new one. */
  ensure(id: string, title: string, agentId: string) {
    this.db.prepare(`INSERT INTO conversations(id, title, agent_id) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET agent_id = COALESCE(conversations.agent_id, excluded.agent_id)`).run(id, title.replace(/\s+/g, " ").trim().slice(0, 120) || "New chat", agentId);
  }

  rename(id: string, title: string) {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.replace(/\s+/g, " ").trim().slice(0, 120), id);
  }

  setArchived(id: string, archived: boolean) {
    this.db.prepare(`UPDATE conversations SET archived_at = ${archived ? "CURRENT_TIMESTAMP" : "NULL"} WHERE id = ?`).run(id);
  }

  private summary(row: Row): SessionSummary {
    return {
      id: row.id, title: row.title || "Untitled chat", agentId: row.agent_id, updatedAt: iso(row.updated_at),
      archived: Boolean(row.archived_at), preview: (row.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 140), turns: Number(row.turns) || 0
    };
  }
}
