-- ============================================================================
-- Agent Orchestrator - Schema Optimization & Indexing Migration
-- ============================================================================
-- This migration adds production-ready indexes, constraints, and optimizations
-- for efficient querying of conversations, agents, tasks, plans, and traces.
--
-- Run this as an additive migration (version 002+) against existing databases.
-- All operations are idempotent with CREATE INDEX IF NOT EXISTS patterns.
-- ============================================================================

-- ============================================================================
-- SECTION 1: CONVERSATIONS & MESSAGES OPTIMIZATION
-- ============================================================================

-- Composite index for recent conversations query (used in listConversations)
CREATE INDEX IF NOT EXISTS idx_conversations_composite ON conversations(agent_id, archived_at DESC, updated_at DESC);

-- Index for filtering by user and agent (used in relatedConversationHistory)
CREATE INDEX IF NOT EXISTS idx_conversations_user_agent ON conversations(user_id, agent_id);

-- Partial index for active conversations only
CREATE INDEX IF NOT EXISTS idx_conversations_active ON conversations(id) WHERE archived_at IS NULL;

-- Composite index for messages with context filtering (used in recentMessages, conversationMessages)
CREATE INDEX IF NOT EXISTS idx_messages_composite ON messages(conversation_id, role, created_at DESC);

-- Partial index for active context messages (JEV use case)
CREATE INDEX IF NOT EXISTS idx_messages_active_context ON messages(conversation_id, active_context, created_at DESC) WHERE active_context = 1;

-- Composite index for full-text search patterns (title + content)
CREATE INDEX IF NOT EXISTS idx_messages_searchable ON messages(conversation_id, lower(content));

-- Index for agent filtering in messages
CREATE INDEX IF NOT EXISTS idx_messages_agent_role ON messages(agent_id, role);

-- ============================================================================
-- SECTION 2: AGENTS & TOOLS OPTIMIZATION  
-- ============================================================================

-- Composite index for agent lookups by name/status (used in findAgents, listAgents)
CREATE INDEX IF NOT EXISTS idx_agents_search ON agents(name, status, can_delegate);

-- Index for provider/model-based queries
CREATE INDEX IF NOT EXISTS idx_agents_provider_model ON agents(provider_id, model);

-- Index for n8n/socket/cli link lookups
CREATE INDEX IF NOT EXISTS idx_agents_links ON agents(n8n_link_id, socket_link_id, cli_link_id);

-- Composite index for agent-tools priority ordering
CREATE INDEX IF NOT EXISTS idx_agent_tools_priority ON agent_tools(agent_id, tool_id, priority DESC);

-- Index for enabled/disabled tools filtering
CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(name, enabled);

-- ============================================================================
-- SECTION 3: TASKS & PLANS OPTIMIZATION
-- ============================================================================

-- Composite index for task hierarchy queries (used in monitorSnapshot)
CREATE INDEX IF NOT EXISTS idx_tasks_hierarchy ON tasks(root_id, parent_id, status, priority DESC, created_at DESC);

-- Partial index for pending/active tasks
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(id, root_id, status, priority DESC, created_at DESC) WHERE status IN ('pending', 'blocked');

-- Index for agent-based task filtering
CREATE INDEX IF NOT EXISTS idx_tasks_agent_owner ON tasks(agent_id, root_id, status);

-- Composite index for plan-step lookups (used in monitorSnapshot)
CREATE INDEX IF NOT EXISTS idx_plans_steps ON plans(task_id, objective, status) INCLUDE (rowid);

-- Index for active plans only
CREATE INDEX IF NOT EXISTS idx_plans_active ON plans(task_id, objective, status) WHERE status = 'active';

-- Composite index for plan steps with position ordering
CREATE INDEX IF NOT EXISTS idx_plan_steps_position ON plan_steps(plan_id, position DESC, status, result);

-- ============================================================================
-- SECTION 4: TRACES & TOOL RUNS OPTIMIZATION
-- ============================================================================

-- Composite index for trace lookups (used in monitorSnapshot)
CREATE INDEX IF NOT EXISTS idx_traces_composite ON traces(conversation_id, task_id, agent_id, kind, created_at DESC);

-- Partial index for recent traces
CREATE INDEX IF NOT EXISTS idx_traces_recent ON traces(id, task_id, agent_id, kind, data_json) WHERE rowid IN (SELECT rowid FROM traces ORDER BY created_at DESC LIMIT 30);

-- Index for tool-run task correlation (used in recentToolRunRefs)
CREATE INDEX IF NOT EXISTS idx_tool_runs_composite ON tool_runs(conversation_id, task_id, agent_id, tool_name, status, created_at DESC);

-- Partial index for non-expand tool runs
CREATE INDEX IF NOT EXISTS idx_tool_runs_non_expand ON tool_runs(id, tool_name, created_at DESC) WHERE tool_name <> 'expand_tool_result';

-- Index for queue run status filtering
CREATE INDEX IF NOT EXISTS idx_queue_runs_status_label ON queue_runs(label, status, created_at DESC);

-- ============================================================================
-- SECTION 5: MEMORIES & ENTITIES OPTIMIZATION
-- ============================================================================

-- Composite index for memory retrieval with agent filtering (used in recentMemories)
CREATE INDEX IF NOT EXISTS idx_memories_composite ON memories(agent_id, conversation_id, type, importance DESC, confidence DESC, created_at DESC);

-- Partial index for active memories only
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(id, agent_id, conversation_id, type, content, importance, confidence, created_at) WHERE active = 1;

-- Index for memory by source message
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_message_id);

-- Composite index for entity lookups (used in findEntities)
CREATE INDEX IF NOT EXISTS idx_entities_composite ON entities(type, name, data_json, created_at DESC);

-- Partial index for active relations (used in findKnowledge)
CREATE INDEX IF NOT EXISTS idx_relations_active ON relations(source_id, predicate, target_id, confidence DESC, created_at DESC) WHERE active = 1;

-- Composite index for relation queries with entity joins
CREATE INDEX IF NOT EXISTS idx_relations_source_predicate ON relations(source_id, predicate, target_id);

-- ============================================================================
-- SECTION 6: TASK-ENTITIES OPTIMIZATION
-- ============================================================================

-- Index for task-entity weight lookups (used in JEV context construction)
CREATE INDEX IF NOT EXISTS idx_task_entities_composite ON task_entities(task_id, entity_id, weight DESC);

-- ============================================================================
-- SECTION 7: SCHEMA VERSION TRACKING
-- ============================================================================

-- Ensure schema_version table exists and has initial value if not present
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY);
INSERT OR IGNORE INTO schema_version(version) VALUES (2);

-- ============================================================================
-- SECTION 8: PERFORMANCE TUNING (PRAGMA SETTINGS)
-- ============================================================================

-- Set cache size for better performance on moderate-sized databases
PRAGMA cache_size = -64000;  -- 64MB cache (negative = KB, so -64000 = 64MB)

-- Enable WAL mode if not already enabled (should be in constructor)
PRAGMA journal_mode = WAL;

-- Set synchronous to NORMAL for good balance of durability and performance
PRAGMA synchronous = NORMAL;

-- Increase max connections if needed
PRAGMA max_connections = 100;

-- ============================================================================
-- SECTION 9: INTEGRITY CONSTRAINTS (Optional but Recommended)
-- ============================================================================

-- Add NOT NULL constraints where appropriate (run after data migration)
-- Note: SQLite doesn't enforce foreign keys by default - use PRAGMA foreign_keys=ON at runtime

-- Example: Add unique constraint on agent names (if not already present via UNIQUE column definition)
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_unique ON agents(name);

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
