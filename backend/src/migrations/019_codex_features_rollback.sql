-- Rollback Migration 019: Remove Codex-like features
-- This script reverses all changes made in migration 019

-- ============================================
-- Step 1: Drop indexes and views (in reverse order of creation)
-- ============================================

-- Drop indexes for query history with workspace filtering
DROP INDEX IF EXISTS idx_query_history_workspace_agent;
DROP INDEX IF EXISTS idx_query_history_workspace_type;

-- Drop indexes for memory importance ranking
DROP INDEX IF EXISTS idx_memories_importance;

-- Drop indexes for entity type distribution
DROP INDEX IF EXISTS idx_entities_type;

-- Drop indexes for relation cardinality
DROP INDEX IF EXISTS idx_relations_target_cardinality;
DROP INDEX IF EXISTS idx_relations_source_cardinality;

-- Drop indexes for query type distribution
DROP INDEX IF EXISTS idx_query_type_distribution;

-- Drop indexes for agent activity
DROP INDEX IF EXISTS idx_agent_activity;

-- Drop indexes for conversation query history
DROP INDEX IF EXISTS idx_conversation_query_history;

-- Drop indexes for task progress
DROP INDEX IF EXISTS idx_task_progress;

-- Drop materialized views for workspace-scoped memory search results
DROP VIEW IF EXISTS v_memories_search_workspace;

-- Drop materialized views for workspace-scoped entity search results
DROP VIEW IF EXISTS v_entities_search_workspace;

-- Drop materialized views for workspace-scoped relation search results
DROP VIEW IF EXISTS v_relations_search_workspace;

-- Drop views for workspace-scoped query analysis
DROP VIEW IF EXISTS v_query_history_analysis;

-- Drop views for workspace-scoped memory importance ranking
DROP VIEW IF EXISTS v_memories_importance_ranked;

-- Drop views for workspace-scoped entity type distribution
DROP VIEW IF EXISTS v_entities_type_distribution;

-- Drop views for workspace-scoped relation cardinality
DROP VIEW IF EXISTS v_relations_cardinality;

-- Drop views for workspace-scoped query type distribution
DROP VIEW IF EXISTS v_query_type_distribution;

-- Drop views for workspace-scoped agent activity
DROP VIEW IF EXISTS v_agent_activity;

-- Drop views for workspace-scoped conversation history
DROP VIEW IF EXISTS v_conversation_query_history;

-- Drop views for workspace-scoped task progress
DROP VIEW IF EXISTS v_task_progress;

-- ============================================
-- Step 2: Drop triggers (in reverse order of creation)
-- ============================================

-- Drop query_history FTS5 triggers
DROP TRIGGER IF EXISTS qh_update_fts ON query_history;
DROP TRIGGER IF EXISTS qh_delete_fts ON query_history;
DROP TRIGGER IF EXISTS qh_insert_fts ON query_history;

-- Drop relations FTS5 triggers
DROP TRIGGER IF EXISTS rel_update_fts ON relations;
DROP TRIGGER IF EXISTS rel_delete_fts ON relations;
DROP TRIGGER IF EXISTS rel_insert_fts ON relations;

-- Drop entities FTS5 triggers
DROP TRIGGER IF EXISTS ent_update_fts ON entities;
DROP TRIGGER IF EXISTS ent_delete_fts ON entities;
DROP TRIGGER IF EXISTS ent_insert_fts ON entities;

-- Drop memories FTS5 triggers
DROP TRIGGER IF EXISTS mem_update_fts ON memories;
DROP TRIGGER IF EXISTS mem_delete_fts ON memories;
DROP TRIGGER IF EXISTS mem_insert_fts ON memories;

-- ============================================
-- Step 3: Drop workspace_id update triggers
-- ============================================

DROP TRIGGER IF EXISTS mem_workspace_update ON memories;
DROP TRIGGER IF EXISTS ent_workspace_update ON entities;
DROP TRIGGER IF EXISTS rel_workspace_update ON relations;
DROP TRIGGER IF EXISTS qh_workspace_update ON query_history;

-- ============================================
-- Step 4: Drop FTS5 virtual tables (in reverse order of creation)
-- ============================================

-- Drop workspace-scoped FTS5 tables
DROP TABLE IF EXISTS fts_query_history_workspace;
DROP TABLE IF EXISTS fts_relations_workspace;
DROP TABLE IF EXISTS fts_entities_workspace;
DROP TABLE IF EXISTS fts_memories_workspace;

-- Drop main FTS5 tables
DROP TABLE IF EXISTS fts_query_history;
DROP TABLE IF EXISTS fts_relations;
DROP TABLE IF EXISTS fts_entities;
DROP TABLE IF EXISTS fts_memories;

-- ============================================
-- Step 5: Drop query_history table
-- ============================================

DROP TABLE IF EXISTS query_history;

-- ============================================
-- Step 6: Remove workspace_id columns from existing tables
-- ============================================

-- Remove workspace_id from traces table
ALTER TABLE traces DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from tool_runs table
ALTER TABLE tool_runs DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from agent_messages table
ALTER TABLE agent_messages DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from plan_steps table
ALTER TABLE plan_steps DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from plans table
ALTER TABLE plans DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from tasks table
ALTER TABLE tasks DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from relations table
ALTER TABLE relations DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from entities table
ALTER TABLE entities DROP COLUMN IF EXISTS workspace_id;

-- Remove workspace_id from memories table
ALTER TABLE memories DROP COLUMN IF EXISTS workspace_id;

-- ============================================
-- Step 7: Verify rollback completion
-- ============================================

-- Check if any FTS5 tables remain (should be none)
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%';

-- Check if query_history table exists (should be none)
SELECT name FROM sqlite_master WHERE type='table' AND name='query_history';

-- Check if workspace_id columns exist (should be none)
SELECT 
    'memories' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('memories') WHERE name='workspace_id'
UNION ALL
SELECT 
    'entities' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('entities') WHERE name='workspace_id'
UNION ALL
SELECT 
    'relations' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('relations') WHERE name='workspace_id'
UNION ALL
SELECT 
    'tasks' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('tasks') WHERE name='workspace_id'
UNION ALL
SELECT 
    'plans' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('plans') WHERE name='workspace_id'
UNION ALL
SELECT 
    'plan_steps' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('plan_steps') WHERE name='workspace_id'
UNION ALL
SELECT 
    'agent_messages' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('agent_messages') WHERE name='workspace_id'
UNION ALL
SELECT 
    'tool_runs' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('tool_runs') WHERE name='workspace_id'
UNION ALL
SELECT 
    'traces' as table_name, COUNT(*) as column_count 
FROM pragma_table_info('traces') WHERE name='workspace_id';

-- ============================================
-- End of Rollback Migration 019
-- ============================================
