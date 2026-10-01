---
name: runtime-schema
description: SQLite schema, versioned migrations, repositories and ID/reference conventions for the VS Code agent runtime (node:sqlite DatabaseSync in globalStorage) — conversations, messages, agents, tools, memories, JEV entities/relations, tasks, plans, plan_steps, agent_messages, tool_runs, summaries, traces/trace_runs, and the UI-driven tables (task_assignees, task_entities, file_changes). Use this whenever you touch backend/src/persistence/database.ts or backend/src/storage/, add or change a table/column/index/query, change a status vocabulary, or the ID/ref format (tool://, memory://, entity://) — even for a "small" column addition, because users already have data and the UI depends on these shapes.
---

# Runtime schema and storage

SQLite is the single source of truth (spec §2.1). The database is `runtime.db` in `context.globalStorageUri`, opened with `node:sqlite` `DatabaseSync` (`backend/src/persistence/database.ts`). A vector index, if one is ever added, is derived data that can be rebuilt from SQLite.

**Users already have this database with data in it.** Every schema change is an additive, versioned migration. Never assume a fresh database.

## Current state

`AgentDatabase.migrate()` creates the spec §9 tables with `CREATE TABLE IF NOT EXISTS`, then patches columns with ad-hoc `PRAGMA table_info` + `ALTER TABLE` checks. It writes `schema_version(version)` = 1. Existing divergences from the spec to keep in mind:
- `agents.status` holds the **run state** (`idle|thinking|running|delegating|waiting|completed|failed`, see `AgentStatus` in `core/types.ts`), not enabled/disabled. `agents` also has `skills_json`, `provider_id`, `n8n_link_id` and `socket_link_id`.
- `tasks` has `root_id`, `depth` and `result`, and `failTask` sets status `blocked` for failures.
- `traces` is one row per event (`kind`, `data_json`) with no request grouping.
- `memories` with `agent_id NULL` means "project" scope (`remember(…, "project")`).
- `queue_runs` persists `TaskQueue` state.

## Migration runner (phase 0)

Replace the ad-hoc logic with a runner in `backend/src/storage/sqlite.ts`:

```ts
export interface Migration { version: number; name: string; sql: string | ((db: DatabaseSync) => void) }
// storage/migrations/001_baseline.ts  — the exact SQL + ALTER checks currently in migrate() (idempotent)
// storage/migrations/002_orchestration_ui.ts — references/002_orchestration_ui.sql
```

- Read `schema_version`. Apply each migration with a greater version inside `BEGIN IMMEDIATE … COMMIT` (roll back on error), then update the version.
- Store migrations as **TypeScript modules exporting SQL strings**. They get inlined into the `bun build` bundle, so nothing has to be copied into `dist/` or found on disk after install. (Bun's `import sql from "./002.sql" with { type: "text" }` would also inline, but it needs a `*.sql` module declaration for `tsc`. Plain TS strings keep typecheck and tests simple.)
- Runtime code uses `node:sqlite` only, because that is what VS Code's Node provides. `bun test` runs the same `node:sqlite` API (verified on Bun 1.4.2, FTS5 included). **Never import `bun:sqlite`** in runtime code, not even as a "faster" path. Treat a missing row as `== null` (`node:sqlite` returns `undefined`).
- 001 must stay idempotent: it runs against databases that already have every 001 table.
- Never edit a migration that has shipped. Add a new one.
- SQLite limits: `ADD COLUMN` cannot use `DEFAULT CURRENT_TIMESTAMP` (non-constant) and should not add CHECKs. Set timestamps in code, and enforce vocabularies in TypeScript types plus the repository. To change a column type or constraint: create the new table, copy the data, drop the old table, and rename, in one transaction with `PRAGMA foreign_keys=OFF` around it.

[references/002_orchestration_ui.sql](references/002_orchestration_ui.sql) is the proposed migration 002. It has been checked to apply cleanly on top of the current schema. It adds:
- **workspace scoping** (`workspace_key` on conversations, tasks, memories, relations). The DB is shared by every VS Code workspace, and the design has a Workspace selector. Entities stay global and relations are scoped. This is a recommendation: confirm it with the user before shipping;
- agent `enabled`, `color`, `sort_order`; tool `category`, `display_name`, `requires_approval`, `allowed_environments`; memory `scope`, `access_count`;
- task `number`, `type`, `tags_json`, `created_by`, `conversation_id`, `started_at`, `updated_at`; plan/step timestamps and `plan_steps.agent_id`; `agent_messages.status`; tool_run `trace_id`, `risk_level`, `approved_by`, `duration_ms`; `summaries.structured_json`;
- new tables `task_assignees`, `task_entities`, `file_changes` (with `before_text`, so the native diff editor can show it), and `trace_runs` (one per request). The existing `traces` table gains `trace_id`, `seq`, `label`, `status` and `duration_ms` and becomes the ordered event list.

## Connection rules

```ts
const db = new DatabaseSync(path.join(storageDir, "runtime.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
```

- Use one connection per activation, created in `activate()`, closed on dispose, and injected everywhere. Never open a second one ad hoc.
- `DatabaseSync` blocks the extension-host thread. Cache prepared statements (`db.prepare` once per query) and keep hot queries on indexes. Split any job that scans large tables into chunks.
- Wrap multi-row writes in a transaction helper: `tx(db, () => { … })` issues `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. JEV conflict updates, plan replacement and summary + `active_context` flips must be atomic. A half-applied conflict leaves two "current" facts, which spec §19 forbids.
- For tests, pass a temp directory. `AgentDatabase` already takes `storageDir`, so keep that constructor seam.

## Repositories

Split `AgentDatabase` (a ~235-line god object) gradually into `backend/src/storage/repositories/{agents,conversations,memories,graph,tasks,plans,tools,traces}.ts`. Keep `AgentDatabase` as a facade until all callers have moved.
- Repositories take and return **domain types** (`backend/src/domain/`), never raw rows. Parse `*_json` columns inside the repository.
- Only SQL lives in repositories: no Laya, no LLM, no business rules. "Deactivate the old relation when a functional predicate changes" belongs to the JEV service. The repository only exposes `deactivateRelation(id, validTo)` and `insertRelation(...)`.
- Parameterised statements only. Identifiers such as sort columns come from an allow-list.
- No `import "vscode"` anywhere in storage (the layering rule in `laya-agent-dev`).

## IDs and references (spec §30)

- The existing code uses bare `randomUUID()`. New rows use `newId(prefix)` from `domain/ids.ts`: `MSG-`, `MEM-`, `ENT-`, `REL-`, `TASK-`, `PLAN-`, `STEP-`, `TR-`, `TRACE-`, `EV-`, `SUM-`, `AMSG-`, `FC-`, `CONV-` + `randomUUID()` (or a sortable ID). Old IDs stay valid. Code must never parse meaning out of an ID beyond its prefix.
- Agent IDs are stable slugs (`supervisor`, `coder`, `researcher`, `planner`, `reviewer`, `devops`, `documenter`, plus the existing `lead`), because policies, colours and seeds key off them.
- Public references are `scheme://ID`: `tool://TR-921`, `memory://MEM-301`, `entity://ENT-44`, `task://TASK-17`, `plan://PLAN-3`, `message://MSG-990`. Put `formatRef`/`parseRef` in `domain/refs.ts`, and a `resolveRef` service to load the full object.
- The display number `#12` = `tasks.number`, allocated inside the insert transaction as `COALESCE(MAX(number),0)+1` per `workspace_key`. Everything else still addresses tasks by ID.

## Status vocabularies (TypeScript unions in `domain/`)

| Field | Values |
|---|---|
| tasks.status | pending · planning · active · blocked · completed · cancelled |
| plans.status | draft · active · superseded · completed · failed |
| plan_steps.status | pending · active · completed · skipped · failed |
| agents.status (run state) | idle · thinking · running · delegating · waiting · completed · failed |
| tool_runs.status | pending_approval · running · completed · failed · rejected (`completed` is the existing value for success) |
| memories.type | working · episodic · semantic · procedural · profile |
| memories.scope | agent · shared · global |
| agent_messages.type | request · response · handoff · event · observation · task · result |
| traces.kind | request · route · decision · memory · jev · vector · tools · context · llm · tool · handoff · plan · task · approval · error · result |

`planning` extends spec §9.9 so the UI can show "Planning". Legacy `traces.kind` values (`routing`, `retrieval`, `model`) map to `route`, `memory`, `llm` when read.

## Seeds

`seedAgents()` currently seeds lead/coder/researcher/planner. Extend it idempotently (`INSERT OR IGNORE`, then fill only NULL columns) to cover the design's agents: Supervisor, Coder, Researcher, Planner, Reviewer, DevOps, Documenter. Set `color`, and set `enabled=0` for agents whose phase hasn't landed, so the UI can list them without the router picking them. Never overwrite a user-edited agent.

## Checklist for a schema change

1. New migration module, registered in the runner, with a test that it applies on a database built by all previous migrations.
2. Domain type + repository method + a repository test on a temp-dir DB.
3. If the UI shows it: update `webview-bridge/references/ui-contract.md`.
4. If a vocabulary changed: update the table above and the UI label map in `workbench-ui`.
