-- Reconstructed from laya_agent_implementation_spec_v2.md §9 and the
-- runtime-schema skill's UI additions. The referenced original 001 file was
-- absent from the supplied workspace.
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    user_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    model TEXT,
    laya_profile TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    enabled INTEGER NOT NULL DEFAULT 1,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    run_state TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    agent_id TEXT REFERENCES agents(id),
    parent_id TEXT REFERENCES tasks(id),
    conversation_id TEXT REFERENCES conversations(id),
    number INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    type TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_number ON tasks(workspace_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    agent_id TEXT REFERENCES agents(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER,
    active_context INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    schema_json TEXT,
    category TEXT,
    display_name TEXT,
    risk_level INTEGER NOT NULL DEFAULT 0,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    allowed_environments TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agent_tools (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    tool_id TEXT NOT NULL REFERENCES tools(id),
    priority REAL NOT NULL DEFAULT 1,
    PRIMARY KEY(agent_id, tool_id)
);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id),
    workspace_id TEXT REFERENCES workspaces(id),
    conversation_id TEXT REFERENCES conversations(id),
    type TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'agent',
    content TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 1.0,
    source_message_id TEXT REFERENCES messages(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_memories_agent_active ON memories(agent_id, active, type);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, name)
);
CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES entities(id),
    predicate TEXT NOT NULL,
    target_id TEXT NOT NULL REFERENCES entities(id),
    confidence REAL NOT NULL DEFAULT 1.0,
    source_message_id TEXT REFERENCES messages(id),
    valid_from TEXT,
    valid_to TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id, predicate, active);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id, active);

CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    objective TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plan_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    position INTEGER NOT NULL,
    agent_id TEXT REFERENCES agents(id),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    started_at TEXT,
    completed_at TEXT
);
CREATE TABLE IF NOT EXISTS task_assignees (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    activity TEXT,
    PRIMARY KEY(task_id, agent_id)
);
CREATE TABLE IF NOT EXISTS task_entities (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    weight REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY(task_id, entity_id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    sender_agent_id TEXT REFERENCES agents(id),
    receiver_agent_id TEXT REFERENCES agents(id),
    task_id TEXT REFERENCES tasks(id),
    type TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'processed',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tool_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id),
    task_id TEXT REFERENCES tasks(id),
    agent_id TEXT REFERENCES agents(id),
    tool_name TEXT NOT NULL,
    arguments_json TEXT,
    result_json TEXT,
    summary TEXT,
    status TEXT NOT NULL,
    trace_id TEXT,
    risk_level INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tool_runs_task ON tool_runs(task_id, created_at);

CREATE TABLE IF NOT EXISTS file_changes (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    tool_run_id TEXT REFERENCES tool_runs(id),
    path TEXT NOT NULL,
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    before_text TEXT,
    diff_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    start_message_id TEXT REFERENCES messages(id),
    end_message_id TEXT REFERENCES messages(id),
    summary TEXT NOT NULL,
    structured_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS trace_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id),
    task_id TEXT REFERENCES tasks(id),
    request_message_id TEXT REFERENCES messages(id),
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    total_ms INTEGER,
    metrics_json TEXT
);
CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES trace_runs(id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT REFERENCES agents(id),
    task_id TEXT REFERENCES tasks(id),
    label TEXT,
    status TEXT,
    duration_ms INTEGER,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(trace_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace_id, seq);
CREATE INDEX IF NOT EXISTS idx_trace_events_task ON trace_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
