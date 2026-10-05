import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

/**
 * Migration 019: Add Codex-like features
 * 
 * This migration adds:
 * - FTS5 virtual tables for semantic memory search (memories, entities, relations, query_history)
 * - Workspace scoping columns to memories/relations/entities tables
 * - Query history table for tracking user queries
 * - Helper views and functions for optimized workspace-scoped searches
 */

export interface MigrationResult {
  success: boolean;
  message: string;
  errors?: string[];
}

/**
 * Apply migration 019 to the SQLite database
 */
export function applyMigration(db: DatabaseSync): MigrationResult {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  
  // Read and execute the migration SQL file
  const migrationSqlPath = path.join(migrationsDir, "019_codex_features.sql");
  if (!fs.existsSync(migrationSqlPath)) {
    return {
      success: false,
      message: `Migration file not found: ${migrationSqlPath}`,
      errors: [`Cannot find migration SQL file at ${migrationSqlPath}`]
    };
  }

  const migrationSql = fs.readFileSync(migrationSqlPath, "utf-8");

  try {
    // Execute the migration
    db.exec(migrationSql);
    
    return {
      success: true,
      message: "Migration 019 applied successfully"
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to apply migration 019: ${errorMessage}`,
      errors: [errorMessage]
    };
  }
}

/**
 * Rollback migration 019 from the SQLite database
 */
export function rollbackMigration(db: DatabaseSync): MigrationResult {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  
  // Read and execute the rollback SQL file
  const rollbackSqlPath = path.join(migrationsDir, "019_codex_features_rollback.sql");
  if (!fs.existsSync(rollbackSqlPath)) {
    return {
      success: false,
      message: `Rollback file not found: ${rollbackSqlPath}`,
      errors: [`Cannot find rollback SQL file at ${rollbackSqlPath}`]
    };
  }

  const rollbackSql = fs.readFileSync(rollbackSqlPath, "utf-8");

  try {
    // Execute the rollback
    db.exec(rollbackSql);
    
    return {
      success: true,
      message: "Migration 019 rolled back successfully"
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to rollback migration 019: ${errorMessage}`,
      errors: [errorMessage]
    };
  }
}

/**
 * Get the current schema version
 */
export function getCurrentSchemaVersion(db: DatabaseSync): number {
  const result = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  return result?.version ?? 0;
}

/**
 * Check if migration 019 has been applied
 */
export function isMigrationApplied(db: DatabaseSync): boolean {
  // Migration 019 adds the query_history table
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_history'").get();
  return !!exists;
}

/**
 * Run migration 019 if not already applied
 */
export function runMigrationIfNotApplied(db: DatabaseSync): MigrationResult {
  const currentVersion = getCurrentSchemaVersion(db);
  
  if (currentVersion >= 19) {
    return {
      success: true,
      message: "Migration 019 has already been applied"
    };
  }

  return applyMigration(db);
}

/**
 * Rollback migration 019 if it was the last migration
 */
export function rollbackLastMigration(db: DatabaseSync): MigrationResult {
  const currentVersion = getCurrentSchemaVersion(db);
  
  if (currentVersion <= 18) {
    return {
      success: true,
      message: "No migrations to rollback"
    };
  }

  // Rollback migration 019
  return rollbackMigration(db);
}

// Export for use in database.ts
export { applyMigration, rollbackMigration, getCurrentSchemaVersion, isMigrationApplied, runMigrationIfNotApplied, rollbackLastMigration };
