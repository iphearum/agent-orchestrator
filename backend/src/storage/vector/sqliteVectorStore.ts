import type { DatabaseSync } from "node:sqlite";

export interface VectorStore {
  get(memoryId: string, model: string): number[] | undefined;
  put(memoryId: string, model: string, vector: number[]): void;
  search(query: number[], model: string, memoryIds: string[], limit: number): Map<string, number>;
}

/** Portable vector projection over SQLite; vectors are rebuildable from the authoritative memories table. */
export class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: DatabaseSync) {}

  get(memoryId: string, model: string): number[] | undefined {
    const row = this.db.prepare("SELECT vector_json FROM memory_vectors WHERE memory_id=? AND embedding_model=?").get(memoryId, model) as { vector_json: string } | undefined;
    if (!row) return undefined;
    try {
      const vector = JSON.parse(row.vector_json);
      return Array.isArray(vector) && vector.length && vector.every(value => typeof value === "number" && Number.isFinite(value)) ? vector : undefined;
    } catch { return undefined; }
  }

  put(memoryId: string, model: string, vector: number[]): void {
    this.db.prepare(`INSERT INTO memory_vectors(memory_id,embedding_model,vector_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(memory_id) DO UPDATE SET embedding_model=excluded.embedding_model,vector_json=excluded.vector_json,updated_at=CURRENT_TIMESTAMP`)
      .run(memoryId, model, JSON.stringify(vector));
  }

  search(query: number[], model: string, memoryIds: string[], limit: number): Map<string, number> {
    if (!memoryIds.length || !query.length) return new Map();
    const rows = this.db.prepare(`SELECT memory_id,vector_json FROM memory_vectors
      WHERE embedding_model=? AND memory_id IN (${memoryIds.map(() => "?").join(",")})`).all(model, ...memoryIds) as Array<{ memory_id: string; vector_json: string }>;
    const ranked = rows.flatMap(row => {
      try {
        const vector = JSON.parse(row.vector_json);
        if (!Array.isArray(vector) || vector.length !== query.length || !vector.every(value => typeof value === "number" && Number.isFinite(value))) return [];
        let dot = 0, a = 0, b = 0;
        for (let i = 0; i < query.length; i++) { dot += query[i] * vector[i]; a += query[i] ** 2; b += vector[i] ** 2; }
        const score = a && b ? dot / Math.sqrt(a * b) : 0;
        return Number.isFinite(score) ? [{ id: row.memory_id, score }] : [];
      } catch { return []; }
    }).sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit));
    return new Map(ranked.map(item => [item.id, item.score]));
  }
}

/** Used in tests or explicitly vector-disabled configurations. */
export class NoVectorStore implements VectorStore {
  get(_memoryId: string, _model: string): number[] | undefined { return undefined; }
  put(_memoryId: string, _model: string, _vector: number[]): void {}
  search(_query: number[], _model: string, _memoryIds: string[], _limit: number): Map<string, number> { return new Map(); }
}
