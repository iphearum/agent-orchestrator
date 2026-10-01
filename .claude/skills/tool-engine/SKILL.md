---
name: tool-engine
description: Tool abstraction, registry, layered tool selection (all → enabled → agent grants → task relevance → Laya → 1-3 schemas), executor, risk levels 0-3 combined with the user's approvalMode (ask/approve/full), tool_runs persistence, tool:// result references, file-change capture and native diff, run_tests parsing for the VS Code agent runtime. Use this whenever you touch backend/src/core/tools.ts, backend/src/tools/, the executeTool switch in the orchestrator, approvals, sandboxing/path safety, shell or test running, or when tool output is too large or leaking into context — including "add a git tool" or "let the agent run tests".
---

# Tool engine

Two goals pull against each other here. The LLM should see only **1–3 tool schemas** per turn (spec §17, "a central optimization target"). And nothing runs just because Laya or the LLM was confident (spec §35).

## What exists

- `core/tools.ts` `AGENT_TOOLS` is a flat array of OpenAI function schemas: `search_workspace`, `read_file`, `write_file`, `list_agents`, `find_agent`, `ask_agent`, `delegate_task`, `remember`, `create_plan`, `remember_entity`, `remember_relation`, `expand_tool_result`, `run_command`.
- `Orchestrator.executeTool()` is a big `switch` on the tool name. `toolsAllowedFor()` and `filterByCategory()` do a rough filter.
- `tools/workspaceTools.ts` holds the file tools on `vscode.workspace.fs`/`findFiles`, and already rejects absolute and `..` paths. `tools/shellTools.ts` runs `exec(command)` with a 120 s timeout.
- The `agentOrchestrator.approvalMode` setting is `ask | approve | full`. Shell only runs in `full`. Approval is a modal prompt built in `extension.ts`.

## Target structure

```
backend/src/tools/            (no vscode imports)
  base.ts        Tool interface, ToolContext, ToolResult
  registry.ts    name -> Tool; synced to the `tools` table (category, display_name, risk_level, requires_approval) at activation
  selector.ts    layered selection -> Tool[] (max 3) + counts for the trace
  executor.ts    grant -> env -> validate -> approval -> run(timeout) -> persist -> summarise -> events
  builtin/       one file per tool (or per small family)
backend/src/vscode/adapters/  WorkspacePort / ShellPort / ApprovalPort implementations using the VS Code API
```

**Ports keep the layering rule.** A tool that needs VS Code (the file system, findFiles, approval UI) depends on an interface such as `WorkspacePort { read, write, find, root }`, and `vscode/adapters/*` implements it. Tests pass a fake port backed by a temp directory. This replaces the `vscode` imports in `tools/workspaceTools.ts` and `tools/shellTools.ts`.

## Tool contract

```ts
export interface Tool<A = unknown> {
  name: string;                 // function name the LLM calls
  displayName: string;          // "Read Files", "Edit File", "Shell Command", "Run Tests", "Web Search", "Code Review"
  description: string;          // one line; this is what the LLM sees
  category: ToolCategory;       // Laya tool-choice key (see laya-policies)
  parameters: JSONSchema;       // OpenAI function parameters, additionalProperties:false
  validate(args: unknown): A;   // throw on invalid; hand-written guard, no runtime deps
  riskLevel: 0 | 1 | 2 | 3;     // 0 read-only · 1 low-risk mutation · 2 system-changing · 3 destructive/external
  requiresApproval?: boolean;
  allowedEnvironments?: string[];
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
export interface ToolResult { ok: boolean; data: unknown; summary: string; fileChanges?: FileChange[]; tests?: TestReport }
```

Allowed agents are **data** (`agent_tools` grants), not a tool property, so the UI Tools page can edit them.

Migrate the existing tools into this shape. The coordination tools (`list_agents`, `find_agent`, `ask_agent`, `delegate_task`, `create_plan`) and the memory/graph tools (`remember*`) are still tools: give them categories and risk 0/1 like the others. Delegation still goes through the guards in `orchestration`.

## Layered selection (spec §17)

```
registry → enabled → granted to this agent (+ environment allowed)
  → task relevance (category matches Laya `tool` answer / plan step / task type)
  → gating mode (laya-policies: execute = that category, enrich = top 2–3 categories, reason = eligible)
  → cap at 3 by agent_tools.priority
```

Emit a `tools` trace event `{registered, enabled, granted, relevant, selected: string[]}`. Spec §34's `eligible=11 selected=2` comes from this event. `tool=none` at execute confidence → **no** schemas, which is a valid outcome. `planMode` (an existing option) → only `create_plan`.

## Approval policy (spec §35 × approvalMode)

One pure function in `executor.ts`, covered by a full truth-table test:

| Risk | ask | approve | full |
|---|---|---|---|
| 0 read-only | auto | auto | auto |
| 1 low-risk mutation (write_file, remember) | prompt | auto only if the tool decision's mode is `execute`; otherwise prompt | auto |
| 2 system-changing (shell, run_tests, git write) | prompt | prompt | auto (the user opted into full access; the existing shell rule) |
| 3 destructive / external side effect | prompt | prompt | **prompt**. Nothing overrides this |

Order: **grant check → environment → argument validation → approval → execute.** A tool the LLM calls without it being granted or offered (LLMs do call tools they weren't given) → `rejected`, and the rejection text goes back to the LLM.

Approval UX (via `ApprovalPort`):
- The run is inserted as `tool_runs.status='pending_approval'`, the agent state becomes `waiting`, and an `approval` trace event is emitted. The webview feed row shows Approve/Reject buttons (`webview-bridge` method `toolRuns.approve`/`reject`). Keep the existing modal prompt as the fallback when no webview is visible.
- The prompt must show the agent, tool, risk, and the exact arguments (the command line, the path + a diff preview). Users can't approve what they can't see.
- A rejection is data returned to the agent ("User rejected run_command …"), not an exception.

## Execution rules

- Every run: a timeout (`Promise.race` with an AbortController), then `duration_ms`, `status`, `risk_level`, `approved_by`, `trace_id`, `task_id` stored in `tool_runs`.
- **Paths:** workspace-relative only; reject absolute paths and `..`, as the existing code does. Also resolve symlinks (`fs.realpath`) and re-check that the result stays under the workspace root. The existing segment check misses symlinks that point outside the root.
- **Shell:** prefer `execFile`/`spawn` with an argv array. When a free-form command string is unavoidable (the existing `run_command`), it is risk 2 and needs full access or approval. Keep the cwd = workspace root, the timeout, and a `maxBuffer` cap. Store the full output in `result_json` and only a summary in context.
- **Edits** (`write_file`, `edit_file`): read the old content first, write through the port (a `WorkspaceEdit` is preferred when the file is open, so it is undoable), compute a unified diff, and return `fileChanges: [{path, additions, deletions, beforeText, diff}]`. The executor persists `file_changes`. The UI's Files Changed list and "Open diff" (the native `vscode.diff` with a `TextDocumentContentProvider` serving `beforeText`) read from it.
- **Tests** (`run_tests`, risk 2): run the project's test command and parse **JUnit XML** or the runner's JSON reporter into `{passed, failed, durationS, cases:[{name, status, durationS}]}`, stored in `result_json.tests`. Don't ask the LLM to parse test output.
- Tool errors are **results**: `status='failed'`, the error message as the summary, and the loop continues. The "tool failure" regression scenario depends on this.

## Result references (spec §30)

The full output goes to `tool_runs.result_json`. The conversation and context get only:
```
tool://TR-921
summary: Found authentication logic in three files.
```
The existing `expand_tool_result` tool is the expansion path. Generalise it to `expand_ref(ref, page?)` for `tool://`, `memory://` and `entity://`, risk 0, granted to every agent (`context-engine` owns the paging budget).

## Events

Each run emits a `tool` trace event with a `label` for the feed (a single sentence, e.g. "Found relevant changes in commit a3f9c2."), `status`, and `data = {tool, displayName, category, ref, durationMs}`. The feed shows `displayName` next to the tool's icon.

## Adding a tool (checklist)

A file in `builtin/` with a schema, a validator, a category, a risk level and a display name → registry + seeded `tools` row + `agent_tools` grants → a new category also gets added to the Laya criteria (`laya-policies`) → tests: happy path, invalid args, not-granted, each approval-mode cell for its risk, and path escape for file tools.
