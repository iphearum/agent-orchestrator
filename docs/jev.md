# Knowledge (JEV)

JEV is the project knowledge graph: typed **entities** and time-versioned **relations** ("facts") such as
`gateway --uses_port--> 9090`. It is separate from memory (remembered text) and from vector search (an optional index).
Code: `backend/src/jev/` (rules), `backend/src/storage/repositories/knowledge.ts` (SQL).

## How a chat session uses it

Each request, before routing:

1. **Seed** entities: the ones the request names (name or alias), plus the entities that earlier turns of the *same chat*
   touched (found through `traces.conversation_id → task_entities`). A follow-up like "now add tests" therefore still sees
   the file the previous turn edited.
2. **Expand** one hop along active relations, strongest and newest first (max 12 facts).
3. The entity names go to Laya's routing state; the facts go into the agent's context when routing asks for graph
   knowledge (`needs_graph`). A `jev` trace records what was used.

While the agents work:

- Every file an agent **reads** or **edits** becomes a `file` entity linked to the chat's task
  (`task_entities`, weight 0.5 read / 1.0 edited; an edit is never downgraded).
- `remember_entity` / `remember_relation` (the agent's own notes) go through the JEV service and are linked to the task.
- The task panel's **Related Knowledge (JEV)** shows the task's linked entities first, then title matches.

## Rules

| Rule | Behaviour |
|---|---|
| Names | Stored normalised (lowercase, single spaces, no trailing punctuation); original spelling kept as `displayName`, others as `aliases`. |
| Types | `concept, entity, event, technology, file, service, agent, task`. Free-form types are mapped (library → technology, table → entity…); older free-form rows (e.g. `project`) are reused, not duplicated. |
| Data | Merged into the entity, never overwritten. |
| Repeated fact | Same source, predicate and target → confidence +0.05, no new row. |
| Single-valued predicates | `uses_port, database, owned_by, runs_on, version, status`: a new value supersedes the old one (`active=0`, `valid_to` set, `jev conflict_resolved` trace). History stays queryable. |
| Other predicates | Many values allowed, including predicates JEV has never seen, so no fact is lost by accident. |
| Transactions | Recording a fact (entities + supersede + insert) is one transaction; a failure changes nothing. |

## Next steps

- **Workspace scoping** (needs a decision): relations carry a `workspace_key` so projects in one database do not mix;
  entities stay global. This is the planned migration 002.
- **Automatic fact extraction** (needs a decision, costs one model call per chat): after a chat turn, extract
  `{entities, facts}` from the conversation as JSON, validate it, and record it through the service.
- **Knowledge (JEV) view**: the sidebar item currently marked "soon" — search entities, see facts and history.
- **Decay**: facts not reinforced for N days lose confidence (never deactivated; deactivation means "superseded").
