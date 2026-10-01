# Webview view-model contract

These are the result types of the `Methods` in `backend/src/shared/protocol.ts`, with example values taken from `target/real_ui_design.png`. The examples double as fixtures: copy them to `webview-ui/src/fixtures/*.json` to build the UI before the runtime produces real data.

Conventions: keys are camelCase (TypeScript), timestamps are ISO-8601 UTC (the UI formats them as "10:24 AM" or "5 min ago"), IDs are prefixed text, and agents are always the compact `AgentRef`.

## Contents
1. Shared types and label maps
2. health.get · workspaces.list
3. agents.list
4. tasks.list · tasks.get
5. tasks.flow
6. tasks.events + pushed events
7. tasks.toolRuns
8. tasks.files
9. tasks.tests
10. tasks.knowledge
11. conversations.*
12. tasks.update

---

## 1. Shared types

```ts
type AgentRef = { id: string; name: string; color: string; state: AgentRunState };
type AgentRunState = "idle" | "thinking" | "running" | "delegating" | "waiting" | "completed" | "failed";
type TaskStatus = "pending" | "planning" | "active" | "blocked" | "completed" | "cancelled";
// UI labels (owned by webview-ui): pending "Queued" · planning "Planning" · active "In Progress"
//   blocked "Blocked" · completed "Done" · cancelled "Cancelled"
// priority: 0 "Low" · 1 "Medium" · 2 "High" · 3 "Urgent"
```

## 2. health.get · workspaces.list

```json
{
  "laya": { "status": "online", "lastError": null },
  "sqlite": { "status": "connected" },
  "agentsRunning": 5,
  "tasksActive": 1,
  "vectorEnabled": false,
  "git": { "branch": "main" }
}
```
`laya.status`: `online | offline | fallback | disabled`, taken from `LayaHttpClient.status` + settings.

```json
[{ "key": "file:///work/ai-gateway", "name": "AI Gateway" }]
```
Workspaces = the open VS Code workspace folders (+ any `workspace_key` present in the DB). Selecting one filters the sidebar.

## 3. agents.list

```json
[
  { "id": "supervisor", "name": "Supervisor", "description": "Coordinates and plans work", "color": "supervisor", "state": "running", "enabled": true, "profile": "global" },
  { "id": "coder", "name": "Coder", "description": "Implementation and debugging", "color": "coder", "state": "running", "enabled": true, "profile": "coder" },
  { "id": "researcher", "name": "Researcher", "description": "External research and analysis", "color": "researcher", "state": "idle", "enabled": true, "profile": "researcher" },
  { "id": "planner", "name": "Planner", "description": "Task breakdown and strategy", "color": "planner", "state": "waiting", "enabled": true, "profile": "planner" },
  { "id": "reviewer", "name": "Reviewer", "description": "Code review and quality", "color": "reviewer", "state": "running", "enabled": true, "profile": "reviewer" },
  { "id": "devops", "name": "DevOps", "description": "Deployment and infrastructure", "color": "devops", "state": "running", "enabled": true, "profile": "devops" },
  { "id": "documenter", "name": "Documenter", "description": "Documentation and guides", "color": "documenter", "state": "idle", "enabled": true, "profile": "documenter" }
]
```

## 4. tasks.list · tasks.get

```json
[
  { "id": "TASK-…", "number": 12, "title": "Fix authentication error", "status": "active" },
  { "id": "TASK-…", "number": 11, "title": "Add user management API", "status": "planning" },
  { "id": "TASK-…", "number": 10, "title": "Improve documentation", "status": "pending" },
  { "id": "TASK-…", "number": 9, "title": "Research best practices", "status": "completed" },
  { "id": "TASK-…", "number": 8, "title": "Set up CI/CD pipeline", "status": "completed" }
]
```

```json
{
  "id": "TASK-…", "number": 12, "title": "Fix authentication error",
  "description": "User reported 500 error on /api/auth/login after database changes. Investigate, fix, and add test.",
  "status": "active", "priority": 2, "type": "bug",
  "tags": ["backend", "bug", "authentication", "priority: high"],
  "createdBy": "Client",
  "createdAt": "2026-09-29T10:24:00Z", "startedAt": "2026-09-29T10:24:00Z", "updatedAt": "2026-09-29T10:27:00Z",
  "owner": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "running" },
  "assignees": [
    { "agent": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "running" }, "activity": "Coordinating" },
    { "agent": { "id": "coder", "name": "Coder", "color": "coder", "state": "running" }, "activity": "Implementing" },
    { "agent": { "id": "researcher", "name": "Researcher", "color": "researcher", "state": "running" }, "activity": "Investigating" },
    { "agent": { "id": "reviewer", "name": "Reviewer", "color": "reviewer", "state": "waiting" }, "activity": "Code review" }
  ],
  "plan": {
    "id": "PLAN-…", "progress": 0.7,
    "steps": [
      { "id": "STEP-1", "position": 1, "description": "Investigate recent changes", "status": "completed", "agentId": "researcher" },
      { "id": "STEP-2", "position": 2, "description": "Identify root cause", "status": "completed", "agentId": "coder" },
      { "id": "STEP-3", "position": 3, "description": "Implement fix", "status": "active", "agentId": "coder" },
      { "id": "STEP-4", "position": 4, "description": "Add/Update tests", "status": "pending", "agentId": "coder" },
      { "id": "STEP-5", "position": 5, "description": "Code review", "status": "pending", "agentId": "reviewer" },
      { "id": "STEP-6", "position": 6, "description": "Deploy / Verify", "status": "pending", "agentId": "devops" }
    ]
  },
  "conversationId": "CONV-…",
  "counts": { "filesChanged": 3, "testsPassed": 12, "testsFailed": 0 },
  "canComplete": false
}
```

`progress` = completed ÷ non-skipped steps. The mock shows 70% with 2 of 6 steps done, so the mock value is illustrative. Agree on a rule before adding partial credit. `canComplete` is false while any child task is unfinished; it disables the Complete button.

## 5. tasks.flow

```json
{
  "nodes": [
    { "id": "client", "kind": "request", "layer": 0, "title": "Client Request", "subtitle": "Fix authentication 500 error", "state": "done" },
    { "id": "supervisor", "kind": "agent", "layer": 1, "agent": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "running" }, "subtitle": "Analyzing and delegating", "state": "active" },
    { "id": "researcher", "kind": "agent", "layer": 2, "agent": { "id": "researcher", "name": "Researcher", "color": "researcher", "state": "running" }, "subtitle": "Checking related changes", "state": "active" },
    { "id": "coder", "kind": "agent", "layer": 2, "agent": { "id": "coder", "name": "Coder", "color": "coder", "state": "running" }, "subtitle": "Inspecting and fixing code", "state": "active" },
    { "id": "devops", "kind": "agent", "layer": 2, "agent": { "id": "devops", "name": "DevOps", "color": "devops", "state": "waiting" }, "subtitle": "Checking environment", "state": "active" },
    { "id": "reviewer", "kind": "agent", "layer": 3, "agent": { "id": "reviewer", "name": "Reviewer", "color": "reviewer", "state": "waiting" }, "subtitle": "Reviewing changes", "state": "pending" },
    { "id": "result", "kind": "result", "layer": 4, "title": "Result", "subtitle": "Fix implemented\nTests added", "state": "done" }
  ],
  "edges": [
    { "from": "client", "to": "supervisor", "type": "request" },
    { "from": "supervisor", "to": "researcher", "type": "handoff" },
    { "from": "supervisor", "to": "coder", "type": "handoff" },
    { "from": "supervisor", "to": "devops", "type": "handoff" },
    { "from": "researcher", "to": "reviewer", "type": "result" },
    { "from": "coder", "to": "reviewer", "type": "result" },
    { "from": "devops", "to": "reviewer", "type": "result" },
    { "from": "reviewer", "to": "result", "type": "result" }
  ]
}
```
Derived from `agent_messages` + `handoff` events of the task and its descendants. `layer` = the longest path from `client`, computed on the host, so the webview needs no graph-layout library. A node's `subtitle` = the agent's latest event label or its `task_assignees.activity`.

## 6. tasks.events + pushed events

```json
[
  { "id": "EV-…", "seq": 1, "at": "2026-09-29T10:24:00Z", "kind": "handoff", "agent": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "running" }, "label": "Analyzing the issue and delegating to Researcher, Coder, and DevOps.", "tool": null, "status": "succeeded" },
  { "id": "EV-…", "seq": 2, "at": "2026-09-29T10:24:00Z", "kind": "tool", "agent": { "id": "researcher", "name": "Researcher", "color": "researcher", "state": "running" }, "label": "Searching for recent database changes and authentication related commits...", "tool": { "name": "web_search", "displayName": "Web Search", "ref": "tool://TR-…" }, "status": "succeeded" },
  { "id": "EV-…", "seq": 3, "at": "2026-09-29T10:25:00Z", "kind": "tool", "agent": { "id": "researcher", "name": "Researcher", "color": "researcher", "state": "running" }, "label": "Found relevant changes in commit a3f9c2. There is a schema change in users table.", "tool": { "name": "read_file", "displayName": "Read Files", "ref": "tool://TR-…" }, "status": "succeeded" },
  { "id": "EV-…", "seq": 5, "at": "2026-09-29T10:27:00Z", "kind": "tool", "agent": { "id": "coder", "name": "Coder", "color": "coder", "state": "running" }, "label": "Found the issue: missing null check for new field. Implementing fix...", "tool": { "name": "write_file", "displayName": "Edit File", "ref": "tool://TR-…" }, "status": "running" },
  { "id": "EV-…", "seq": 10, "at": "2026-09-29T10:32:00Z", "kind": "result", "agent": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "idle" }, "label": "All subtasks completed. The fix has been implemented and tested.", "tool": null, "status": "task_completed" }
]
```

`status` → the right-hand icon: `succeeded` check · `running` spinner · `failed` error · `pending_approval` Approve/Reject buttons (with `toolRunId` in `data`) · `task_completed` the green "Task Completed" badge.

Pushed `RuntimeEvent` kinds (arriving in batches in `{kind:"events"}`):

| kind | data | webview reaction |
|---|---|---|
| any trace kind (`tool`, `handoff`, `decision`, …) | a `WorkEvent` as above | append to the feed if `taskId` matches |
| `agent.state` | `{ agentId, state }` | update dots, flow nodes, assignees |
| `task.updated` | a `TaskView` | replace the cached task |
| `plan.updated` | `{ taskId, progress, steps }` | patch the plan |
| `file.changed` | a `FileChangeView` | upsert into files |
| `tests.updated` | a `TestReportView` | replace tests |

## 7. tasks.toolRuns

```json
[{ "id": "TR-…", "ref": "tool://TR-…", "agentId": "coder", "toolName": "run_tests", "displayName": "Run Tests", "status": "completed", "riskLevel": 2, "summary": "12 passed in 2.4s", "durationMs": 2400, "createdAt": "…", "arguments": { "path": "tests/test_auth.py" } }]
```

## 8. tasks.files

```json
[
  { "id": "FC-…", "path": "src/auth/login.py", "additions": 24, "deletions": 6, "diff": "@@ -42,8 +42,12 @@\n-    user = await db.get_user(email)\n+    user = await db.get_user(email)\n+    if not user:\n+        logger.warning(f\"Login attempt for non-existent user: {email}\")\n+        raise HTTPException(\n+            status_code=401,\n+            detail=\"Invalid credentials\"\n+        )\n     if not verify_password(password, user.hashed_password):" },
  { "id": "FC-…", "path": "src/models/user.py", "additions": 12, "deletions": 0, "diff": "…" },
  { "id": "FC-…", "path": "tests/test_auth.py", "additions": 36, "deletions": 0, "diff": "…" }
]
```
Aggregate repeated changes to one path into a single row (summed counts, the latest cumulative diff, the latest `id`). `ui.openDiff(id)` opens the native diff editor.

## 9. tasks.tests

```json
{ "passed": 12, "failed": 0, "durationS": 2.4, "ref": "tool://TR-…",
  "cases": [
    { "name": "test_login_success", "status": "passed", "durationS": 0.3 },
    { "name": "test_login_invalid_password", "status": "passed", "durationS": 0.2 },
    { "name": "test_login_nonexistent_user", "status": "passed", "durationS": 0.2 },
    { "name": "test_login_locked_account", "status": "passed", "durationS": 0.4 },
    { "name": "test_login_rate_limit", "status": "passed", "durationS": 0.3 }
  ] }
```
`null` means the task has no test run yet.

## 10. tasks.knowledge

```json
[
  { "id": "ENT-…", "ref": "entity://ENT-…", "name": "authentication", "type": "concept", "relationCount": 12 },
  { "id": "ENT-…", "ref": "entity://ENT-…", "name": "users_table", "type": "entity", "relationCount": 8 },
  { "id": "ENT-…", "ref": "entity://ENT-…", "name": "database_migration", "type": "event", "relationCount": 4 },
  { "id": "ENT-…", "ref": "entity://ENT-…", "name": "fastapi", "type": "technology", "relationCount": 15 }
]
```
`relationCount` = active relations touching the entity in this workspace. Sort by `task_entities.weight`, then `relationCount`.

## 11. conversations.*

```json
[{ "id": "CONV-…", "title": "Debug auth 500 error", "updatedAt": "…" }, { "id": "CONV-…", "title": "Design new feature", "updatedAt": "…" }]
```
```json
[{ "id": "MSG-…", "role": "user", "author": { "kind": "user", "name": "Client" }, "content": "Fix the authentication 500 error on /api/auth/login.", "at": "…" },
 { "id": "MSG-…", "role": "assistant", "author": { "kind": "agent", "agent": { "id": "supervisor", "name": "Supervisor", "color": "supervisor", "state": "running" } }, "content": "Got it. Analyzing and delegating the task to the appropriate agents...", "at": "…" }]
```
Only `user` and `assistant`/`result` roles are shown. Tool messages belong in the Tool Calls tab.

## 12. tasks.update

```ts
type TaskPatch = { description?: string; priority?: 0 | 1 | 2 | 3; status?: "completed" | "cancelled" | "active" };
```
Returns the updated `TaskView`, or an error `{ code: "children_incomplete" | "invalid_transition" | "not_found" }`. All transitions go through the task manager, so the UI can't bypass the state machine.
