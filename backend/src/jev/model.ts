/**
 * JEV vocabulary: entity types, name normalisation and predicate cardinality (spec §18–19).
 * Pure functions only; the service applies them and the repository stores the results.
 */

export const ENTITY_TYPES = ["concept", "entity", "event", "technology", "file", "service", "agent", "task"] as const;
export type EntityType = typeof ENTITY_TYPES[number];

/** Free-form types from agents ("library", "table", "module"…) mapped onto the fixed set; unknown ones become concepts. */
const TYPE_ALIASES: Record<string, EntityType> = {
  library: "technology", framework: "technology", language: "technology", tool: "technology", package: "technology", database: "technology",
  table: "entity", model: "entity", schema: "entity", column: "entity", record: "entity",
  migration: "event", incident: "event", release: "event", bug: "event",
  path: "file", module: "file", document: "file", doc: "file",
  api: "service", endpoint: "service", server: "service", app: "service", application: "service", component: "service", project: "service",
  person: "agent", user: "agent", team: "agent",
  issue: "task", ticket: "task", todo: "task"
};

export function coerceEntityType(raw: unknown): EntityType {
  const type = String(raw ?? "").trim().toLowerCase();
  if ((ENTITY_TYPES as readonly string[]).includes(type)) return type as EntityType;
  return TYPE_ALIASES[type] ?? "concept";
}

/** How names are stored and compared: casefolded, single spaces, no trailing punctuation. */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.,;:!?]+$/g, "");
}

/** How the original spelling is kept for display. */
export function displayName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Predicates that can hold only one current value. Recording a new value supersedes the old one (kept as history with
 * valid_to). Everything else — including predicates we have never seen — may hold many values, so no fact is lost by accident.
 */
export const PREDICATES: Record<string, { cardinality: "one" | "many" }> = {
  uses_port: { cardinality: "one" },
  database: { cardinality: "one" },
  owned_by: { cardinality: "one" },
  runs_on: { cardinality: "one" },
  version: { cardinality: "one" },
  status: { cardinality: "one" },
  uses: { cardinality: "many" },
  exposes: { cardinality: "many" },
  depends_on: { cardinality: "many" },
  contains: { cardinality: "many" },
  calls: { cardinality: "many" }
};

/** "Uses Port" / "uses-port" / "usesPort" all become "uses_port". */
export function normalizePredicate(predicate: string): string {
  return predicate
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

export function cardinality(predicate: string): "one" | "many" {
  return PREDICATES[predicate]?.cardinality ?? "many";
}
