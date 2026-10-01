---
name: memory-jev
description: Memory engine (working/episodic/semantic/procedural/profile, store/retrieve/deactivate/reinforce, agent/shared/global scope, workspace scoping), the JEV knowledge graph (entity extraction, normalisation, resolution, relations, predicate cardinality, temporal conflict handling, decay, graph retrieval), optional vector retrieval (VectorStore, NoVectorStore, sqlite-vec) and hybrid scoring for the VS Code agent runtime. Use this whenever you touch remember/recentMemories/findEntities/findKnowledge/upsertEntity/upsertRelation in database.ts, backend/src/memory/, backend/src/jev/, the remember_* tools, the Knowledge (JEV) or Memory views, or anything about remembering facts, "the old value should be replaced", entity links or semantic search.
---

# Memory, JEV and vector retrieval

Three distinct things. Don't let them blur together:
- **Memory** answers "what should be remembered?" It holds text items with a type, importance, confidence, scope and workspace.
- **JEV** answers "what do we know, and how is it related?" It holds typed entities and time-versioned relations. It is not a vector store (spec §18).
- **Vector** is an optional semantic *index* over memories. It is never memory itself and never authoritative (spec §21, §39).

All three are read only when the agent's Laya decision says so (the gating in `laya-policies`).

## What exists, and the gaps to close

In `persistence/database.ts`:
- `remember(agentId, scope, content, type)`: `scope === "project"` → `agent_id NULL`. There is no dedupe, and importance is never set.
- `recentMemories(agentId, limit, query)`: loads the last 100 memories of the agent + project scope and scores them by term overlap + importance + confidence. It ignores recency beyond the ordering, and there is no workspace filter.
- `findEntities` and `findKnowledge`: LIKE scans over entities and active relations.
- `upsertEntity`: `ON CONFLICT(type,name)` **overwrites** `data_json`, and names are not normalised.
- `upsertRelation`: **deactivates every active relation with the same source + predicate, then inserts.** That treats every predicate as single-valued ("gateway uses Redis" wipes "gateway uses FastAPI"). Re-stating an identical fact churns rows instead of reinforcing it. None of it runs in a transaction.
- `relate()` uses `INSERT OR REPLACE` with no temporal handling.

Fix these in the service layer (`backend/src/jev/`, `backend/src/memory/`). Repositories keep the SQL only.

## Memory (`backend/src/memory/`)

```ts
memory.store({ agentId, type, content, scope = "agent", workspaceKey, importance = .5, confidence = 1, conversationId, sourceMessageId })
memory.retrieve({ agentId, query, workspaceKey, types?, limit = 8, useVector = false, taskId? }) -> ScoredMemory[]
memory.deactivate(id, reason)          // active=0, never DELETE
memory.reinforce(id, delta = .1)       // importance/confidence up (cap 1), access_count++
```

| type | holds | written by |
|---|---|---|
| working | current task scratch | orchestrator; set `active=0` when the task completes |
| episodic | what happened ("fixed null check in login.py for #12") | post-processing |
| semantic | facts ("users.email nullable since migration 0042") | extractor / compression |
| procedural | how-tos ("run `bun test auth`") | extractor, when a procedure succeeded |
| profile | durable preferences | explicit user statements only |

**Scope** (phase 5; spec §39: "don't let every agent read every memory"):
- `agent`: visible only to its owner.
- `shared`: visible to the assignees of the same task (`task_assignees`).
- `global`: visible to everyone, and absorbs the legacy "project" scope.

Always filter by `workspace_key`, plus `global` rows. Enforce both in the repository `WHERE` clause; after-the-fact filtering eventually gets forgotten.

**Dedupe:** normalise the content (casefold, collapse whitespace). If an active memory with the same agent, type and normalised content exists, `reinforce` it instead of inserting.

**Extraction** runs in post-processing (`orchestration`). Reuse the structured-compression JSON (`context-engine`), or make one LLM call returning `{facts, decisions, procedures}`, and validate the JSON before storing anything. The existing `remember` tool (the agent saving explicitly) stays, and it goes through `store()` so dedupe applies.

## Retrieval and scoring (spec §23)

Structured filter (workspace, scope, type, active) → lexical candidates → optional vector candidates → score → top-k.

- **Lexical:** add an FTS5 table over `memories.content` in a migration, kept in sync by triggers. `node:sqlite` ships SQLite with FTS5, so this replaces the "load 100 + substring match" approach without any new dependency. Rank with `bm25()`.
- **Score** (the spec's starting weights; put them in config, because they are tunable and not fixed):
  ```ts
  score = semantic * .35 + recency * .15 + importance * .15 + entityOverlap * .15 + taskRelevance * .20
  ```
  With vectors disabled, `semantic` = normalised BM25. `recency` = exponential decay on `accessed_at ?? created_at`. `entityOverlap` = the Jaccard overlap between the entities named in the query and those linked to the memory's message or task. `taskRelevance` = 1 for the same task or conversation, otherwise the overlap with the task title.
- Touch `accessed_at` and `access_count` on hits. Emit a `memory` trace event `{scanned, selected, ids, tokenEstimate}`.

## JEV (`backend/src/jev/`)

Responsibilities (spec §18): extract → normalise → resolve → link → deduplicate → reinforce → conflict-detect → version → decay → retrieve.

**Entities**
- Store `name` normalised (casefold, trim, collapse whitespace, strip trailing punctuation). Keep the original spelling in `data_json.displayName` and alternate names in `data_json.aliases`. **Merge** `data_json`; don't overwrite it.
- Resolve by `(type, name)`, then by alias. Only merge automatically within the same type.
- Types (one enum): `concept`, `entity` (a table/model), `event` (a migration or incident), `technology`, `file`, `service`, `agent`, `task`. The UI shows an icon per type.
- Entities are global. Relations carry the `workspace_key` (migration 002).

**Relations and conflicts (spec §19).** The system has to know which predicates are single-valued:

```ts
export const PREDICATES: Record<string, { cardinality: "one" | "many" }> = {
  uses_port: { cardinality: "one" }, database: { cardinality: "one" }, owned_by: { cardinality: "one" },
  runs_on: { cardinality: "one" },
  uses: { cardinality: "many" }, exposes: { cardinality: "many" }, depends_on: { cardinality: "many" },
};
// unknown predicates default to "many" — never overwrite facts by accident
```

Upsert, inside **one transaction**:
1. Resolve or create the source and target entities.
2. An identical active `(source, predicate, target, workspace)` exists → reinforce its confidence. No new row.
3. Otherwise, if the cardinality is `one` and an active `(source, predicate, *)` exists → set `active=0, valid_to=now` on it, insert the new relation with `active=1, valid_from=now`, and emit a `jev` event `conflict_resolved {old, new}`.
4. Otherwise insert the new relation.

This replaces `upsertRelation`'s deactivate-everything behaviour. History stays queryable through `valid_from`/`valid_to`, and there are never two contradictory active facts.

**Decay:** relations not reinforced in N days lose confidence, and retrieval ignores those below a floor. Decay never deactivates a relation: deactivation means "superseded", which is a different fact. Run the pass in chunks (the DB is synchronous; see `runtime-schema`).

**Retrieval:** seed entities (names or aliases in the query + the task's `task_entities`) → 1-hop traversal over active relations in this workspace (2 hops only when asked) → rank by confidence × recency → fit the budget. Return triples (`gateway → uses_port → 8080`) + `entity://` refs. Emit a `jev` event `{entities, relations}`.

**Task links:** every entity touched while working on a task → upsert `task_entities(task_id, entity_id, weight)`. That powers the "Related Knowledge (JEV)" panel (name, type, active relation count).

## Vector (`backend/src/storage/vector/`, phase 6 only)

- The spec §21 interface in TS: `VectorStore { add(id, vector, metadata); search(vector, limit) }`, `NoVectorStore`, and `createVectorStore(config)`. Everything must work with `NoVectorStore`.
- An `EmbeddingProvider` sits next to the LLM adapters. Embed a query only when the gating says `needs_vector`. Embed memories lazily or in post-processing.
- `sqlite-vec` is a native SQLite extension. Loading it into `node:sqlite` requires `allowExtension` and a per-platform binary shipped in the VSIX. That is a packaging decision, so confirm it with the user before starting. Whatever store is used, it must be rebuildable from `memories`.
- The regression test for vector-disabled mode: the full pipeline with vector off → no embedding calls and no `vector` trace event.
