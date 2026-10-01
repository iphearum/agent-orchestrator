import { randomUUID } from "crypto";
import type { DatabaseSync } from "node:sqlite";
import { KnowledgeRepository, type EntityRow, type FactRow } from "../storage/repositories/knowledge";
import { cardinality, coerceEntityType, displayName, normalizeName, normalizePredicate, type EntityType } from "./model";

export interface FactInput {
  sourceName: string; sourceType?: unknown;
  predicate: string;
  targetName: string; targetType?: unknown;
  confidence?: number;
  sourceMessageId?: string;
}

/** What recording a fact did: a new fact, a repeat that strengthened an existing one, or a new value that superseded old ones. */
export interface FactResult {
  relationId: string;
  sourceId: string;
  targetId: string;
  predicate: string;
  outcome: "inserted" | "reinforced" | "replaced";
  replaced: Array<{ relationId: string; targetId: string }>;
}

export interface KnowledgeEntity { id: string; name: string; type: string; ref: string }
export interface KnowledgeFact { id: string; source: string; predicate: string; target: string; confidence: number; text: string; refs: string[] }
export interface KnowledgeResult { entities: KnowledgeEntity[]; facts: KnowledgeFact[] }

/** Link weights for task_entities: a file an agent edited matters more than one it only read. */
export const LINK_WEIGHT = { edited: 1, read: .5, mentioned: .7 } as const;

const parseData = (json: string | null): Record<string, unknown> => {
  try { const data = JSON.parse(json || "{}"); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
};
const shown = (row: { name: string; data_json?: string | null }, data?: string | null) => {
  const name = parseData(data ?? row.data_json ?? null).displayName;
  return typeof name === "string" && name ? name : row.name;
};
const queryTerms = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])].slice(0, 12);

/**
 * The JEV knowledge graph (spec §18–19): resolve entities, record facts with cardinality-aware conflict handling,
 * link entities to tasks, and retrieve the facts around what a request mentions.
 */
export class JevService {
  private readonly repo: KnowledgeRepository;

  constructor(db: DatabaseSync) { this.repo = new KnowledgeRepository(db); }

  /** Find or create an entity. Same type + name (or a known alias) resolves to one row; its data is merged, never replaced. */
  upsertEntity(rawType: unknown, name: string, data: unknown = {}): string {
    const type = coerceEntityType(rawType);
    const normalized = normalizeName(name);
    if (!normalized) throw new Error("Entity name must not be empty.");
    const spelled = displayName(name);
    const incoming = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    // Rows written before types were fixed keep their free-form type ("project"); find those too instead of duplicating them.
    const legacyType = String(rawType ?? "").trim().toLowerCase();
    const existing = this.repo.entityByName(type, normalized)
      ?? (legacyType && legacyType !== type ? this.repo.entityByName(legacyType, normalized) : undefined)
      ?? this.byAlias(type, normalized);
    if (existing) {
      const prior = parseData(existing.data_json);
      const aliases = [...new Set([...(Array.isArray(prior.aliases) ? prior.aliases : []), ...(Array.isArray(incoming.aliases) ? incoming.aliases : []), spelled]
        .filter((alias): alias is string => typeof alias === "string" && normalizeName(alias) !== existing.name))];
      const merged = { ...prior, ...incoming, displayName: prior.displayName || incoming.displayName || spelled, aliases };
      this.repo.updateEntityData(existing.id, JSON.stringify(merged));
      return existing.id;
    }
    const id = randomUUID();
    this.repo.insertEntity(id, type, normalized, JSON.stringify({ ...incoming, displayName: incoming.displayName || spelled, aliases: Array.isArray(incoming.aliases) ? incoming.aliases : [] }));
    return id;
  }

  /**
   * Record "source predicate target". In one transaction:
   * an identical active fact is reinforced; a single-valued predicate supersedes the current value (kept as history);
   * anything else is added alongside existing facts.
   */
  recordFact(input: FactInput): FactResult {
    const predicate = normalizePredicate(input.predicate);
    if (!predicate) throw new Error("A fact needs a predicate.");
    const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : .8));
    return this.repo.transaction(() => {
      const sourceId = this.upsertEntity(input.sourceType ?? "concept", input.sourceName);
      const targetId = this.upsertEntity(input.targetType ?? "concept", input.targetName);
      const identical = this.repo.activeRelation(sourceId, predicate, targetId);
      if (identical) {
        this.repo.reinforceRelation(identical.id, confidence, input.sourceMessageId);
        return { relationId: identical.id, sourceId, targetId, predicate, outcome: "reinforced" as const, replaced: [] };
      }
      const replaced = cardinality(predicate) === "one"
        ? this.repo.activeRelationsFrom(sourceId, predicate).map(row => { this.repo.deactivateRelation(row.id); return { relationId: row.id, targetId: row.target_id }; })
        : [];
      const relationId = randomUUID();
      this.repo.insertRelation(relationId, sourceId, predicate, targetId, confidence, input.sourceMessageId);
      return { relationId, sourceId, targetId, predicate, outcome: replaced.length ? "replaced" as const : "inserted" as const, replaced };
    });
  }

  /** Remember that a task involved an entity; the task's "Related Knowledge (JEV)" panel reads these links. */
  linkToTask(taskId: string, entityId: string, weight: number = LINK_WEIGHT.mentioned) {
    this.repo.linkTask(taskId, entityId, Math.max(0, Math.min(1, weight)));
  }

  /** A workspace file an agent read or edited during a task, as a file entity linked to that task. */
  linkFile(taskId: string, path: string, how: "read" | "edited"): string | undefined {
    const clean = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!clean || clean.length > 500) return undefined;
    const entityId = this.upsertEntity("file", clean, { path: clean });
    this.linkToTask(taskId, entityId, LINK_WEIGHT[how]);
    return entityId;
  }

  /**
   * Knowledge for a request: entities named in it, plus what earlier turns of the same chat (and the task) touched,
   * then the active facts one hop around them.
   */
  retrieve(options: { query: string; conversationId?: string; taskIds?: string[]; limit?: number }): KnowledgeResult {
    const limit = Math.max(1, Math.min(40, options.limit ?? 12));
    const terms = queryTerms(options.query);
    const named = this.repo.entitiesMatching(terms, 24)
      .map(row => ({ row, score: terms.filter(term => row.name.includes(term) || (row.data_json ?? "").toLowerCase().includes(term)).length }))
      .sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.row);
    const sessionTasks = [...(options.taskIds ?? []), ...(options.conversationId ? this.repo.conversationTaskIds(options.conversationId, 10) : [])];
    const linked = this.repo.entitiesById(this.repo.taskEntityIds([...new Set(sessionTasks)], 12));
    const seeds = new Map<string, EntityRow>();
    for (const row of [...named, ...linked]) if (!seeds.has(row.id)) seeds.set(row.id, row);
    const facts = this.repo.factsAround([...seeds.keys()], limit).map(row => this.toFact(row));
    const entities = [...seeds.values()].map(row => ({ id: row.id, name: shown(row), type: row.type, ref: `entity://${row.id}` }));
    return { entities, facts };
  }

  private byAlias(type: EntityType, normalized: string): EntityRow | undefined {
    return this.repo.entitiesMentioning(type, normalized).find(row => {
      const aliases = parseData(row.data_json).aliases;
      return Array.isArray(aliases) && aliases.some(alias => typeof alias === "string" && normalizeName(alias) === normalized);
    });
  }

  private toFact(row: FactRow): KnowledgeFact {
    const source = shown({ name: row.source_name }, row.source_data);
    const target = shown({ name: row.target_name }, row.target_data);
    return {
      id: row.id, source, predicate: row.predicate, target, confidence: row.confidence,
      text: `${source} --${row.predicate}--> ${target}`,
      refs: [`entity://${row.source_id}`, `entity://${row.target_id}`]
    };
  }
}
