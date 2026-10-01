import type { DatabaseSync } from "node:sqlite";

/** JEV storage: SQL only. Resolution, cardinality and conflict rules live in backend/src/jev/service.ts. */
export interface EntityRow { id: string; type: string; name: string; data_json: string | null; created_at: string }
export interface RelationRow { id: string; source_id: string; predicate: string; target_id: string; confidence: number; active: number; valid_from: string | null; valid_to: string | null }
export interface FactRow {
  id: string; predicate: string; confidence: number; created_at: string;
  source_id: string; source_name: string; source_type: string; source_data: string | null;
  target_id: string; target_name: string; target_type: string; target_data: string | null;
}

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Runs `fn` in one write transaction, so a fact and the value it supersedes change together. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  entity(id: string): EntityRow | undefined {
    return this.db.prepare("SELECT id, type, name, data_json, created_at FROM entities WHERE id = ?").get(id) as EntityRow | undefined;
  }

  entityByName(type: string, name: string): EntityRow | undefined {
    return this.db.prepare("SELECT id, type, name, data_json, created_at FROM entities WHERE type = ? AND lower(name) = ? ORDER BY created_at LIMIT 1").get(type, name) as EntityRow | undefined;
  }

  /** Candidates whose metadata mentions the name; the caller checks the aliases list exactly. */
  entitiesMentioning(type: string, name: string): EntityRow[] {
    return this.db.prepare("SELECT id, type, name, data_json, created_at FROM entities WHERE type = ? AND lower(data_json) LIKE ? LIMIT 20").all(type, `%${name}%`) as unknown as EntityRow[];
  }

  insertEntity(id: string, type: string, name: string, dataJson: string) {
    this.db.prepare("INSERT INTO entities(id, type, name, data_json) VALUES (?, ?, ?, ?)").run(id, type, name, dataJson);
  }

  updateEntityData(id: string, dataJson: string) {
    this.db.prepare("UPDATE entities SET data_json = ? WHERE id = ?").run(dataJson, id);
  }

  activeRelation(sourceId: string, predicate: string, targetId: string): RelationRow | undefined {
    return this.db.prepare("SELECT * FROM relations WHERE source_id = ? AND predicate = ? AND target_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(sourceId, predicate, targetId) as RelationRow | undefined;
  }

  activeRelationsFrom(sourceId: string, predicate: string): RelationRow[] {
    return this.db.prepare("SELECT * FROM relations WHERE source_id = ? AND predicate = ? AND active = 1").all(sourceId, predicate) as unknown as RelationRow[];
  }

  reinforceRelation(id: string, confidence: number, sourceMessageId?: string) {
    this.db.prepare("UPDATE relations SET confidence = MIN(1.0, MAX(confidence, ?) + 0.05), source_message_id = COALESCE(source_message_id, ?) WHERE id = ?").run(confidence, sourceMessageId ?? null, id);
  }

  /** Superseded, not deleted: the old value stays queryable with its valid_to. */
  deactivateRelation(id: string) {
    this.db.prepare("UPDATE relations SET active = 0, valid_to = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  insertRelation(id: string, sourceId: string, predicate: string, targetId: string, confidence: number, sourceMessageId?: string) {
    this.db.prepare("INSERT INTO relations(id, source_id, predicate, target_id, confidence, source_message_id, valid_from, active) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)")
      .run(id, sourceId, predicate, targetId, confidence, sourceMessageId ?? null);
  }

  /** Entities whose name or aliases contain any of the terms. */
  entitiesMatching(terms: string[], limit: number): EntityRow[] {
    if (!terms.length) return [];
    const where = terms.map(() => "(lower(name) LIKE ? OR lower(data_json) LIKE ?)").join(" OR ");
    return this.db.prepare(`SELECT id, type, name, data_json, created_at FROM entities WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...terms.flatMap(term => [`%${term}%`, `%${term}%`]), limit) as unknown as EntityRow[];
  }

  entitiesById(ids: string[]): EntityRow[] {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT id, type, name, data_json, created_at FROM entities WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as unknown as EntityRow[];
  }

  /** Active facts touching any of the entities (one hop), strongest and newest first. */
  factsAround(entityIds: string[], limit: number): FactRow[] {
    if (!entityIds.length) return [];
    const marks = entityIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT r.id, r.predicate, r.confidence, r.created_at,
        s.id AS source_id, s.name AS source_name, s.type AS source_type, s.data_json AS source_data,
        t.id AS target_id, t.name AS target_name, t.type AS target_type, t.data_json AS target_data
      FROM relations r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
      WHERE r.active = 1 AND (r.source_id IN (${marks}) OR r.target_id IN (${marks}))
      ORDER BY r.confidence DESC, r.created_at DESC LIMIT ?`).all(...entityIds, ...entityIds, limit) as unknown as FactRow[];
  }

  /** Keeps the strongest link: an edit (1.0) is not downgraded by a later read (0.5). */
  linkTask(taskId: string, entityId: string, weight: number) {
    this.db.prepare(`INSERT INTO task_entities(task_id, entity_id, weight) VALUES (?, ?, ?)
      ON CONFLICT(task_id, entity_id) DO UPDATE SET weight = MAX(weight, excluded.weight)`).run(taskId, entityId, weight);
  }

  /** Entities linked to these tasks, heaviest first. */
  taskEntityIds(taskIds: string[], limit: number): string[] {
    if (!taskIds.length) return [];
    return (this.db.prepare(`SELECT entity_id, MAX(weight) AS weight FROM task_entities WHERE task_id IN (${taskIds.map(() => "?").join(",")})
      GROUP BY entity_id ORDER BY weight DESC LIMIT ?`).all(...taskIds, limit) as Array<{ entity_id: string }>).map(row => row.entity_id);
  }

  /** Root tasks that ran in a conversation, newest first (tasks have no conversation column; traces link them). */
  conversationTaskIds(conversationId: string, limit: number): string[] {
    return (this.db.prepare(`SELECT task_id, MAX(rowid) AS last FROM traces WHERE conversation_id = ? GROUP BY task_id ORDER BY last DESC LIMIT ?`)
      .all(conversationId, limit) as Array<{ task_id: string }>).map(row => row.task_id);
  }
}
