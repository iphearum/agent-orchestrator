-- Migration 019: Add Codex-like features
-- - FTS5 virtual table for semantic memory search
-- - Workspace scoping columns to memories/relations/entities tables
-- - Query history table

-- ============================================
-- Step 1: Create workspace scoping column on existing tables
-- ============================================

-- Add workspace_id to memories table (nullable for backward compatibility)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to entities table (nullable for backward compatibility)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to relations table (nullable for backward compatibility)
ALTER TABLE relations ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to tasks table (nullable for backward compatibility)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to plans table (nullable for backward compatibility)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to plan_steps table (nullable for backward compatibility)
ALTER TABLE plan_steps ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to agent_messages table (nullable for backward compatibility)
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to tool_runs table (nullable for backward compatibility)
ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Add workspace_id to traces table (nullable for backward compatibility)
ALTER TABLE traces ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- ============================================
-- Step 2: Create FTS5 virtual table for semantic search
-- ============================================

-- Create FTS5 virtual table for memories with full-text search capability
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
    content,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- Create FTS5 virtual table for entities with full-text search capability
CREATE VIRTUAL TABLE IF NOT EXISTS fts_entities USING fts5(
    data_json,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- Create FTS5 virtual table for relations with full-text search capability
CREATE VIRTUAL TABLE IF NOT EXISTS fts_relations USING fts5(
    predicate,
    source_id,
    target_id,
    confidence,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 3: Create query_history table for tracking user queries
-- ============================================

CREATE TABLE IF NOT EXISTS query_history (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    task_id TEXT,
    agent_id TEXT,
    query_text TEXT NOT NULL,
    query_type TEXT DEFAULT 'general',  -- general, code, debug, research, plan
    metadata_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    result_summary TEXT,
    token_count INTEGER,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);

-- Create indexes for efficient query history lookups
CREATE INDEX IF NOT EXISTS idx_query_history_conversation ON query_history(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_task ON query_history(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_agent ON query_history(agent_id, created_at DESC);

-- ============================================
-- Step 4: Create FTS5 virtual table for query history
-- ============================================

CREATE VIRTUAL TABLE IF NOT EXISTS fts_query_history USING fts5(
    query_text,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 5: Create indexes on workspace_id columns
-- ============================================

CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace_id, type, name);
CREATE INDEX IF NOT EXISTS idx_relations_workspace ON relations(workspace_id, source_id, target_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, root_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id, task_id, status);

-- ============================================
-- Step 6: Create FTS5 virtual table for workspace-scoped memories
-- ============================================

-- This allows searching memories within a specific workspace
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories_workspace USING fts5(
    content,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 7: Create FTS5 virtual table for workspace-scoped entities
-- ============================================

CREATE VIRTUAL TABLE IF NOT EXISTS fts_entities_workspace USING fts5(
    data_json,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 8: Create FTS5 virtual table for workspace-scoped relations
-- ============================================

CREATE VIRTUAL TABLE IF NOT EXISTS fts_relations_workspace USING fts5(
    predicate,
    source_id,
    target_id,
    confidence,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 9: Create FTS5 virtual table for workspace-scoped query history
-- ============================================

CREATE VIRTUAL TABLE IF NOT EXISTS fts_query_history_workspace USING fts5(
    query_text,
    tokenize=porter,
    content='id',
    journal_mode=WAL
);

-- ============================================
-- Step 10: Create helper views for workspace-scoped searches
-- ============================================

-- View for workspace-scoped memories with FTS5 join
CREATE VIEW IF NOT EXISTS v_memories_fts_workspace AS
SELECT 
    m.id,
    m.content,
    m.importance,
    m.confidence,
    m.created_at,
    fts.rowid AS fts_rowid,
    fts.content AS content_fts
FROM memories m
JOIN fts_memories_workspace fts ON fts.content == m.id AND fts.workspace_id = m.workspace_id;

-- View for workspace-scoped entities with FTS5 join
CREATE VIEW IF NOT EXISTS v_entities_fts_workspace AS
SELECT 
    e.id,
    e.type,
    e.name,
    e.data_json,
    e.created_at,
    fts.rowid AS fts_rowid,
    fts.content AS content_fts
FROM entities e
JOIN fts_entities_workspace fts ON fts.content == e.id AND fts.workspace_id = e.workspace_id;

-- View for workspace-scoped relations with FTS5 join
CREATE VIEW IF NOT EXISTS v_relations_fts_workspace AS
SELECT 
    r.id,
    r.source_id,
    r.target_id,
    r.predicate,
    r.confidence,
    r.created_at,
    fts.rowid AS fts_rowid,
    fts.content AS content_fts
FROM relations r
JOIN fts_relations_workspace fts ON fts.content == r.id AND fts.workspace_id = r.workspace_id;

-- ============================================
-- Step 11: Create helper views for query history with FTS5 join
-- ============================================

CREATE VIEW IF NOT EXISTS v_query_history_fts AS
SELECT 
    qh.id,
    qh.query_text,
    qh.query_type,
    qh.created_at,
    fts.rowid AS fts_rowid,
    fts.content AS content_fts
FROM query_history qh
JOIN fts_query_history fts ON fts.content == qh.id AND fts.workspace_id = qh.workspace_id;

-- ============================================
-- Step 12: Create triggers for automatic FTS5 updates
-- ============================================

-- Trigger to update memories FTS5 table on insert
CREATE TRIGGER IF NOT EXISTS mem_insert_fts AFTER INSERT ON memories
BEGIN
    INSERT OR REPLACE INTO fts_memories(workspace_id, content, id) 
    VALUES (NEW.workspace_id, NEW.content, NEW.id);
END;

-- Trigger to update memories FTS5 table on delete
CREATE TRIGGER IF NOT EXISTS mem_delete_fts AFTER DELETE ON memories
BEGIN
    UPDATE fts_memories SET deleted=1 WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update memories FTS5 table on update
CREATE TRIGGER IF NOT EXISTS mem_update_fts AFTER UPDATE ON memories
BEGIN
    UPDATE fts_memories SET content = NEW.content, id = NEW.id 
    WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update entities FTS5 table on insert
CREATE TRIGGER IF NOT EXISTS ent_insert_fts AFTER INSERT ON entities
BEGIN
    INSERT OR REPLACE INTO fts_entities(workspace_id, data_json, id) 
    VALUES (NEW.workspace_id, NEW.data_json, NEW.id);
END;

-- Trigger to update entities FTS5 table on delete
CREATE TRIGGER IF NOT EXISTS ent_delete_fts AFTER DELETE ON entities
BEGIN
    UPDATE fts_entities SET deleted=1 WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update entities FTS5 table on update
CREATE TRIGGER IF NOT EXISTS ent_update_fts AFTER UPDATE ON entities
BEGIN
    UPDATE fts_entities SET data_json = NEW.data_json, id = NEW.id 
    WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update relations FTS5 table on insert
CREATE TRIGGER IF NOT EXISTS rel_insert_fts AFTER INSERT ON relations
BEGIN
    INSERT OR REPLACE INTO fts_relations(workspace_id, predicate, source_id, target_id, confidence, id) 
    VALUES (NEW.workspace_id, NEW.predicate, NEW.source_id, NEW.target_id, NEW.confidence, NEW.id);
END;

-- Trigger to update relations FTS5 table on delete
CREATE TRIGGER IF NOT EXISTS rel_delete_fts AFTER DELETE ON relations
BEGIN
    UPDATE fts_relations SET deleted=1 WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update relations FTS5 table on update
CREATE TRIGGER IF NOT EXISTS rel_update_fts AFTER UPDATE ON relations
BEGIN
    UPDATE fts_relations SET predicate = NEW.predicate, source_id = NEW.source_id, 
                          target_id = NEW.target_id, confidence = NEW.confidence, id = NEW.id 
    WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update query_history FTS5 table on insert
CREATE TRIGGER IF NOT EXISTS qh_insert_fts AFTER INSERT ON query_history
BEGIN
    INSERT OR REPLACE INTO fts_query_history(workspace_id, query_text, id) 
    VALUES (NEW.workspace_id, NEW.query_text, NEW.id);
END;

-- Trigger to update query_history FTS5 table on delete
CREATE TRIGGER IF NOT EXISTS qh_delete_fts AFTER DELETE ON query_history
BEGIN
    UPDATE fts_query_history SET deleted=1 WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- Trigger to update query_history FTS5 table on update
CREATE TRIGGER IF NOT EXISTS qh_update_fts AFTER UPDATE ON query_history
BEGIN
    UPDATE fts_query_history SET query_text = NEW.query_text, id = NEW.id 
    WHERE rowid = OLD.id AND workspace_id = OLD.workspace_id;
END;

-- ============================================
-- Step 13: Create indexes for FTS5 tables
-- ============================================

CREATE INDEX IF NOT EXISTS idx_fts_memories_workspace ON fts_memories_workspace(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fts_entities_workspace ON fts_entities_workspace(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fts_relations_workspace ON fts_relations_workspace(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fts_query_history_workspace ON fts_query_history_workspace(workspace_id);

-- ============================================
-- Step 14: Create materialized views for performance optimization
-- ============================================

-- Materialized view for workspace-scoped memory search results
CREATE VIEW IF NOT EXISTS v_memories_search_workspace AS
SELECT 
    m.id,
    m.content,
    m.importance,
    m.confidence,
    m.created_at,
    m.accessed_at,
    fts.rowid AS fts_rowid,
    CASE 
        WHEN m.workspace_id IS NOT NULL THEN 1 
        ELSE 0 
    END AS is_workspace_scoped
FROM memories m
LEFT JOIN fts_memories_workspace fts ON fts.content == m.id AND fts.workspace_id = m.workspace_id;

-- Materialized view for workspace-scoped entity search results
CREATE VIEW IF NOT EXISTS v_entities_search_workspace AS
SELECT 
    e.id,
    e.type,
    e.name,
    e.data_json,
    e.created_at,
    fts.rowid AS fts_rowid,
    CASE 
        WHEN e.workspace_id IS NOT NULL THEN 1 
        ELSE 0 
    END AS is_workspace_scoped
FROM entities e
LEFT JOIN fts_entities_workspace fts ON fts.content == e.id AND fts.workspace_id = e.workspace_id;

-- Materialized view for workspace-scoped relation search results
CREATE VIEW IF NOT EXISTS v_relations_search_workspace AS
SELECT 
    r.id,
    r.source_id,
    r.target_id,
    r.predicate,
    r.confidence,
    r.created_at,
    fts.rowid AS fts_rowid,
    CASE 
        WHEN r.workspace_id IS NOT NULL THEN 1 
        ELSE 0 
    END AS is_workspace_scoped
FROM relations r
LEFT JOIN fts_relations_workspace fts ON fts.content == r.id AND fts.workspace_id = r.workspace_id;

-- ============================================
-- Step 15: Create indexes for query history analysis
-- ============================================

CREATE INDEX IF NOT EXISTS idx_query_history_type ON query_history(query_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_agent_type ON query_history(agent_id, query_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_conversation_type ON query_history(conversation_id, query_type, created_at DESC);

-- ============================================
-- Step 16: Create function for workspace-scoped FTS5 search
-- ============================================

-- Function to search memories in a specific workspace
CREATE FUNCTION IF NOT EXISTS search_memories_workspace(
    workspace_id TEXT,
    query TEXT,
    limit INTEGER DEFAULT 10,
    importance_threshold REAL DEFAULT 0.0
) RETURNS TABLE AS
$$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        m.content,
        m.importance,
        m.confidence,
        m.created_at,
        fts.rowid AS fts_rowid
    FROM memories m
    JOIN fts_memories_workspace fts ON fts.content == m.id AND fts.workspace_id = m.workspace_id
    WHERE fts.matchquery = query
      AND (m.importance >= importance_threshold OR importance_threshold IS NULL)
    ORDER BY m.importance DESC, fts.score DESC
    LIMIT limit;
END;
$$ LANGUAGE SQL;

-- Function to search entities in a specific workspace
CREATE FUNCTION IF NOT EXISTS search_entities_workspace(
    workspace_id TEXT,
    query TEXT,
    limit INTEGER DEFAULT 10
) RETURNS TABLE AS
$$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.type,
        e.name,
        e.data_json,
        fts.rowid AS fts_rowid
    FROM entities e
    JOIN fts_entities_workspace fts ON fts.content == e.id AND fts.workspace_id = e.workspace_id
    WHERE fts.matchquery = query
    ORDER BY fts.score DESC
    LIMIT limit;
END;
$$ LANGUAGE SQL;

-- Function to search relations in a specific workspace
CREATE FUNCTION IF NOT EXISTS search_relations_workspace(
    workspace_id TEXT,
    query TEXT,
    limit INTEGER DEFAULT 10
) RETURNS TABLE AS
$$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        r.source_id,
        r.target_id,
        r.predicate,
        r.confidence,
        fts.rowid AS fts_rowid
    FROM relations r
    JOIN fts_relations_workspace fts ON fts.content == r.id AND fts.workspace_id = r.workspace_id
    WHERE fts.matchquery = query
    ORDER BY fts.score DESC
    LIMIT limit;
END;
$$ LANGUAGE SQL;

-- Function to search query history in a specific workspace
CREATE FUNCTION IF NOT EXISTS search_query_history_workspace(
    workspace_id TEXT,
    query TEXT,
    limit INTEGER DEFAULT 10
) RETURNS TABLE AS
$$
BEGIN
    RETURN QUERY
    SELECT 
        qh.id,
        qh.query_text,
        qh.query_type,
        qh.created_at,
        fts.rowid AS fts_rowid
    FROM query_history qh
    JOIN fts_query_history_workspace fts ON fts.content == qh.id AND fts.workspace_id = qh.workspace_id
    WHERE fts.matchquery = query
    ORDER BY fts.score DESC
    LIMIT limit;
END;
$$ LANGUAGE SQL;

-- ============================================
-- Step 17: Create indexes for FTS5 tables with workspace filtering
-- ============================================

CREATE INDEX IF NOT EXISTS idx_fts_memories_workspace_content ON fts_memories_workspace(workspace_id, content);
CREATE INDEX IF NOT EXISTS idx_fts_entities_workspace_data ON fts_entities_workspace(workspace_id, data_json);
CREATE INDEX IF NOT EXISTS idx_fts_relations_workspace_pred ON fts_relations_workspace(workspace_id, predicate);

-- ============================================
-- Step 18: Create views for workspace-scoped query analysis
-- ============================================

CREATE VIEW IF NOT EXISTS v_query_history_analysis AS
SELECT 
    qh.query_type,
    qh.agent_id,
    COUNT(*) AS query_count,
    MIN(qh.created_at) AS first_query,
    MAX(qh.created_at) AS last_query,
    AVG(qh.token_count) AS avg_tokens
FROM query_history qh
GROUP BY qh.query_type, qh.agent_id;

-- ============================================
-- Step 19: Create indexes for workspace-scoped queries
-- ============================================

CREATE INDEX IF NOT EXISTS idx_memories_workspace_created ON memories(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_workspace_created ON entities(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relations_workspace_created ON relations(workspace_id, created_at DESC);

-- ============================================
-- Step 20: Create indexes for query history with workspace filtering
-- ============================================

CREATE INDEX IF NOT EXISTS idx_query_history_workspace_type ON query_history(workspace_id, query_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_history_workspace_agent ON query_history(workspace_id, agent_id, query_type, created_at DESC);

-- ============================================
-- Step 21: Create triggers for workspace_id updates (for existing records)
-- ============================================

-- Note: These triggers will only fire on INSERT/UPDATE, not on ALTER TABLE
-- They are provided for completeness but won't automatically migrate existing data
CREATE TRIGGER IF NOT EXISTS mem_workspace_update AFTER UPDATE ON memories
WHEN OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
BEGIN
    -- Update FTS5 table if workspace_id changed
    UPDATE fts_memories SET workspace_id = NEW.workspace_id WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS ent_workspace_update AFTER UPDATE ON entities
WHEN OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
BEGIN
    UPDATE fts_entities SET workspace_id = NEW.workspace_id WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS rel_workspace_update AFTER UPDATE ON relations
WHEN OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
BEGIN
    UPDATE fts_relations SET workspace_id = NEW.workspace_id WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS qh_workspace_update AFTER UPDATE ON query_history
WHEN OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
BEGIN
    UPDATE fts_query_history SET workspace_id = NEW.workspace_id WHERE rowid = OLD.id;
END;

-- ============================================
-- Step 22: Create indexes for FTS5 tables with confidence filtering
-- ============================================

CREATE INDEX IF NOT EXISTS idx_fts_relations_confidence ON fts_relations_workspace(workspace_id, confidence DESC);

-- ============================================
-- Step 23: Create views for workspace-scoped memory importance ranking
-- ============================================

CREATE VIEW IF NOT EXISTS v_memories_importance_ranked AS
SELECT 
    m.id,
    m.content,
    m.importance,
    m.confidence,
    m.created_at,
    ROW_NUMBER() OVER (
        PARTITION BY m.workspace_id 
        ORDER BY m.importance DESC, m.confidence DESC, m.created_at DESC
    ) AS importance_rank
FROM memories m;

-- ============================================
-- Step 24: Create indexes for memory importance ranking
-- ============================================

CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(workspace_id, importance DESC, confidence DESC, created_at DESC);

-- ============================================
-- Step 25: Create views for workspace-scoped entity type distribution
-- ============================================

CREATE VIEW IF NOT EXISTS v_entities_type_distribution AS
SELECT 
    e.type,
    COUNT(*) AS entity_count,
    MIN(e.created_at) AS first_entity,
    MAX(e.created_at) AS last_entity
FROM entities e
GROUP BY e.type;

-- ============================================
-- Step 26: Create indexes for entity type distribution
-- ============================================

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(workspace_id, type);

-- ============================================
-- Step 27: Create views for workspace-scoped relation cardinality
-- ============================================

CREATE VIEW IF NOT EXISTS v_relations_cardinality AS
SELECT 
    r.source_id,
    COUNT(*) AS outgoing_relations,
    SUM(r.confidence) AS total_confidence_outgoing
FROM relations r
GROUP BY r.source_id;

CREATE VIEW IF NOT EXISTS v_relations_target_cardinality AS
SELECT 
    r.target_id,
    COUNT(*) AS incoming_relations,
    SUM(r.confidence) AS total_confidence_incoming
FROM relations r
GROUP BY r.target_id;

-- ============================================
-- Step 28: Create indexes for relation cardinality
-- ============================================

CREATE INDEX IF NOT EXISTS idx_relations_source_cardinality ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target_cardinality ON relations(target_id);

-- ============================================
-- Step 29: Create views for workspace-scoped query type distribution
-- ============================================

CREATE VIEW IF NOT EXISTS v_query_type_distribution AS
SELECT 
    qh.query_type,
    COUNT(*) AS query_count,
    MIN(qh.created_at) AS first_query,
    MAX(qh.created_at) AS last_query,
    AVG(qh.token_count) AS avg_tokens,
    SUM(qh.token_count) AS total_tokens
FROM query_history qh
GROUP BY qh.query_type;

-- ============================================
-- Step 30: Create indexes for query type distribution
-- ============================================

CREATE INDEX IF NOT EXISTS idx_query_type_distribution ON query_history(query_type);

-- ============================================
-- Step 31: Create views for workspace-scoped agent activity
-- ============================================

CREATE VIEW IF NOT EXISTS v_agent_activity AS
SELECT 
    qh.agent_id,
    COUNT(*) AS query_count,
    MIN(qh.created_at) AS first_query,
    MAX(qh.created_at) AS last_query,
    AVG(qh.token_count) AS avg_tokens
FROM query_history qh
GROUP BY qh.agent_id;

-- ============================================
-- Step 32: Create indexes for agent activity
-- ============================================

CREATE INDEX IF NOT EXISTS idx_agent_activity ON query_history(agent_id);

-- ============================================
-- Step 33: Create views for workspace-scoped conversation history
-- ============================================

CREATE VIEW IF NOT EXISTS v_conversation_query_history AS
SELECT 
    c.id AS conversation_id,
    c.title,
    qh.id AS query_id,
    qh.query_text,
    qh.query_type,
    qh.agent_id,
    qh.created_at,
    qh.processed_at,
    qh.result_summary,
    qh.token_count
FROM conversations c
JOIN query_history qh ON qh.conversation_id = c.id;

-- ============================================
-- Step 34: Create indexes for conversation query history
-- ============================================

CREATE INDEX IF NOT EXISTS idx_conversation_query_history ON query_history(conversation_id);

-- ============================================
-- Step 35: Create views for workspace-scoped task progress
-- ============================================

CREATE VIEW IF NOT EXISTS v_task_progress AS
SELECT 
    t.id AS task_id,
    t.title,
    t.status,
    COUNT(DISTINCT p.id) AS plan_count,
    COUNT(DISTINCT ps.id) AS step_count,
    SUM(ps.status = 'completed') AS completed_steps,
    MAX(t.completed_at) AS last_completed_at
FROM tasks t
LEFT JOIN plans p ON p.task_id = t.id
LEFT JOIN plan_steps ps ON ps.plan_id = p.id
GROUP BY t.id, t.title, t.status;

-- ============================================
-- Step 36: Create indexes for task progress
-- ============================================

CREATE INDEX IF NOT EXISTS idx_task_progress ON tasks(status);

-- ============================================
-- End of Migration 019
-- ============================================
