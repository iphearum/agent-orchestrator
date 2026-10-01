-- Migration 002 — applied on top of the CURRENT schema created by
-- backend/src/persistence/database.ts (treat that as migration 001).
-- Embed as a string in backend/src/storage/migrations/002_orchestration_ui.ts.
-- Rules: SQLite ALTER TABLE ADD COLUMN cannot use a non-constant default
-- (no DEFAULT CURRENT_TIMESTAMP) and cannot add CHECK constraints on existing
-- rows safely, so timestamps are set in code and vocabularies are enforced in TS.
-- "UI" = needed by target/real_ui_design.png; "trace" = spec §2.1/§34.

-- Workspace scoping: DB lives in globalStorage and is shared by every VS Code workspace.
-- workspace_key = first workspace folder URI (or "global"). Entities stay global; relations are scoped.
ALTER TABLE conversations ADD COLUMN workspace_key TEXT;
ALTER TABLE tasks         ADD COLUMN workspace_key TEXT;
ALTER TABLE memories      ADD COLUMN workspace_key TEXT;
ALTER TABLE relations     ADD COLUMN workspace_key TEXT;

-- Agents: existing `status` already holds the run state (AgentStatus: idle|thinking|running|delegating|waiting|completed|failed).
ALTER TABLE agents ADD COLUMN enabled INTEGER DEFAULT 1;
ALTER TABLE agents ADD COLUMN color TEXT;            -- UI hue key: supervisor|coder|researcher|…
ALTER TABLE agents ADD COLUMN sort_order INTEGER DEFAULT 0;

-- Tools: metadata required by spec §35 + UI display name.
ALTER TABLE tools ADD COLUMN category TEXT;          -- Laya tool-choice key
ALTER TABLE tools ADD COLUMN display_name TEXT;      -- "Read Files", "Run Tests"
ALTER TABLE tools ADD COLUMN requires_approval INTEGER DEFAULT 0;
ALTER TABLE tools ADD COLUMN allowed_environments TEXT;  -- JSON array or NULL

-- Memories: phase-5 scoping. Existing rows with agent_id NULL were "project" scope.
ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT 'agent';   -- agent|shared|global
ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;
UPDATE memories SET scope = 'global' WHERE agent_id IS NULL;

-- Tasks (UI header, sidebar, details).
ALTER TABLE tasks ADD COLUMN number INTEGER;          -- "#12", unique per workspace_key
ALTER TABLE tasks ADD COLUMN type TEXT;               -- bug|feature|docs|research|chore
ALTER TABLE tasks ADD COLUMN tags_json TEXT;
ALTER TABLE tasks ADD COLUMN created_by TEXT;
ALTER TABLE tasks ADD COLUMN conversation_id TEXT;
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_number ON tasks(workspace_key, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_ws_status ON tasks(workspace_key, status);

ALTER TABLE plans      ADD COLUMN created_at TEXT;
ALTER TABLE plan_steps ADD COLUMN agent_id TEXT;
ALTER TABLE plan_steps ADD COLUMN started_at TEXT;
ALTER TABLE plan_steps ADD COLUMN completed_at TEXT;

ALTER TABLE agent_messages ADD COLUMN status TEXT DEFAULT 'processed';  -- queued|delivered|processed|failed

ALTER TABLE tool_runs ADD COLUMN trace_id TEXT;
ALTER TABLE tool_runs ADD COLUMN risk_level INTEGER;
ALTER TABLE tool_runs ADD COLUMN approved_by TEXT;
ALTER TABLE tool_runs ADD COLUMN duration_ms INTEGER;

ALTER TABLE summaries ADD COLUMN structured_json TEXT;  -- facts/decisions/open_tasks/entities/relationships

-- UI: assignees cards.
CREATE TABLE IF NOT EXISTS task_assignees (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    activity TEXT,
    PRIMARY KEY (task_id, agent_id)
);

-- UI: Related Knowledge (JEV).
CREATE TABLE IF NOT EXISTS task_entities (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    weight REAL DEFAULT 1.0,
    PRIMARY KEY (task_id, entity_id)
);

-- UI: Files Changed + Code Changes.
CREATE TABLE IF NOT EXISTS file_changes (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    tool_run_id TEXT REFERENCES tool_runs(id),
    path TEXT NOT NULL,                  -- workspace-relative
    additions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,
    before_text TEXT,                    -- enables native vscode.diff via a content provider
    diff_text TEXT,                      -- unified diff for the inline view
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_file_changes_task ON file_changes(task_id, created_at);

-- trace: one row per request. The existing `traces` table becomes its ordered event list.
CREATE TABLE IF NOT EXISTS trace_runs (
    id TEXT PRIMARY KEY,                 -- TRACE-…
    conversation_id TEXT,
    task_id TEXT,
    request_message_id TEXT,
    status TEXT DEFAULT 'running',       -- running|completed|failed
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    total_ms INTEGER,
    metrics_json TEXT
);
ALTER TABLE traces ADD COLUMN trace_id TEXT;
ALTER TABLE traces ADD COLUMN seq INTEGER;
ALTER TABLE traces ADD COLUMN label TEXT;          -- one human sentence for the Agent Work feed
ALTER TABLE traces ADD COLUMN status TEXT;         -- succeeded|running|failed|pending_approval|task_completed
ALTER TABLE traces ADD COLUMN duration_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_traces_trace ON traces(trace_id, seq);
CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(source_id, predicate, active);
CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(target_id, active);
