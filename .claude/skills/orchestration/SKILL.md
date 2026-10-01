---
name: orchestration
description: The VS Code agent runtime's orchestrator pipeline (normalize → save → global Laya route → agent state → local Laya → retrieval → tool selection → context → LLM → tool loop → save → post-process → trace), LLM adapters (OpenAI-compatible/Anthropic), tasks vs plans state machines, supervisor fan-out and planner delegation, structured agent_messages handoff with depth/count/cycle guards, remote agents (n8n/socket), TaskQueue, tracing and the runtime event bus that feeds webviews and chat. Use this whenever you touch backend/src/core/orchestrator.ts, runRoot/runAgent/delegate, RunEvent, TaskQueue, AgentMessageBus, backend/src/tasks/, backend/src/models/, tracing, or anything about "the agent loop", delegation, task status, plan progress, or "why is there no trace".
---

# Orchestration, tasks and tracing

The orchestrator sequences the other services and holds no business rules of its own. It calls decision, memory, JEV, tools, context and the LLM in the order spec §4 defines, and it records a trace of every step.

## What exists

`core/orchestrator.ts` (566 lines) does everything in one class. `runRoot(instruction, rootAgentId = "lead", autoRoute, options)` → `runAgent(...)` runs a tool loop of up to 20 turns → `executeTool` (a switch) → `delegate` (guards: `maxDelegationDepth` 3, `maxDelegationsPerTask` 8, no cycles through `ancestorAgents`) → `fitContext` / `buildSystemPrompt` → `emit(RunEvent)`. Remote agents run through `RemoteAgentRunner` (n8n) and `SocketAgentRunner`. `TaskQueue` limits concurrency (`maxConcurrentTasks`) and persists `queue_runs`. `RunEvent` = `start|message|chunk|stream_reset|delegate|tool|result|error`, consumed by the chat UIs.

Refactor toward the pipeline **incrementally**, keeping `runRoot`'s signature and the `RunEvent` stream working. The chat participant and the chat webview depend on both.

## The pipeline

`Orchestrator.handle()` (spec §31) runs the 20 steps of §4, grouped:

1. **Ingest:** normalise the input, open a trace run (`trace_runs`), save the user message, and resolve or create the task (`#number`, `workspace_key`, `created_by`).
2. **Route:** without an explicit agent → the global policy (Supervisor). Resolve the agent row, and skip disabled agents.
3. **Decide:** a compact `AgentState` (spec §13; the existing `AgentState` type fits) → the agent's profile policy (`laya-policies`).
4. **Retrieve**, gated: memory → JEV → vector (`memory-jev`).
5. **Select tools** (`tool-engine`) → **build context** (`context-engine`).
6. **Generate:** `needs_llm` → the LLM. Otherwise the direct-action handler (a tool-only answer, a status lookup, plan continuation).
7. **Tool loop:** execute → append refs + summaries → call the LLM again. Stop on a final answer, `maxToolIterations` (make the hardcoded 20 a setting), a pending approval, or repeated identical calls. Trace each iteration.
8. **Persist** the assistant message with its `agent_id`.
9. **Post-process** (spec §32): memory extraction → JEV → task/plan update → compression check → finalise the trace. It is synchronous in V1, behind one `postprocess()` so it can move to a background job later. No external queue infrastructure.
10. **Return** `{message, agent, toolsUsed, memoryUsed, graphUsed, traceId, taskId, pendingApprovals}` (the shape of spec §33).

The **first deliverable** (spec §41) is this path with one agent, driven by the `@orchestrator` chat participant or the chat webview, and covered end to end by an integration test before any multi-agent autonomy.

Keep the decision predicates (`requiresMemory`, `…Graph`, `…Vector`, `…Llm`) as small pure functions in `decision/result.ts`.

## LLM adapters

`core/model.ts` `OpenAICompatibleModel` handles both `protocol: "openai" | "anthropic"`, providers from settings, API keys in `context.secrets`, and streaming chunks. Move it to `backend/src/models/` behind an `LLMProvider` interface (`chat(messages, tools, selection, onChunk?) → {content, toolCalls, usage}`), so tests can inject a scripted fake. Record the provider, model, token usage and latency in an `llm` trace event.

Use the main LLM for low-confidence decisions, synthesis, code generation, multi-step reasoning and user-visible text (spec §29). Routing and gating go to Laya. The LLM invocation rate per trace is the headline optimisation metric.

## Tasks vs plans (spec §27)

A **task** is the objective, and a **plan** is the strategy. They live in separate tables, and neither holds the other's data.

Task state machine (`backend/src/tasks/manager.ts` is the only writer of `tasks.status`):

```
pending ─▶ planning ─▶ active ─▶ completed
   │          │          │  ▲
   └────────▶ cancelled  ▼  │
                       blocked (approval / dependency / child)
```
- `active` sets `started_at`. Every change sets `updated_at` and emits a `task` event. `completed` requires all children to be `completed` or `cancelled`. The UI's Complete button calls the same method.
- The existing `failTask` writes `blocked` + an error `result`. Keep that (the UI shows Blocked with the error) unless the user wants a distinct `failed` status.
- `createTask` currently titles tasks with the first 160 characters of the instruction. Prefer a short LLM- or heuristic-generated title when the LLM is already being called.

Plans (`backend/src/tasks/planner.ts`; the existing `create_plan` tool writes plans today):
- One `active` plan per task. `replan` → the old plan becomes `superseded` and a new plan is created, with completed steps' results carried across.
- Steps: `pending → active → completed|failed|skipped`, each with an optional `agent_id`, plus `started_at` and `completed_at`.
- **Progress** = completed ÷ non-skipped steps of the active plan, computed on read.

## Delegation and fan-out (phases 4–5)

Communication is structured only (spec §28). Every interaction is an `agent_messages` row with a typed payload:

```json
{"type":"request","sender":"supervisor","receiver":"coder","task_id":"TASK-…",
 "payload":{"task":"Inspect authentication implementation","expected_output":"Root cause and recommended change"}}
```

- Delegating creates a **child task** (`parent_id`, `root_id`, `depth+1`) owned by the receiver, adds a `task_assignees` row, and posts the request. The receiver replies with a `result` whose payload is a summary + refs, never its whole transcript.
- Keep the existing guards (depth, count, cycles). A violation returns a structured error to the caller agent; it doesn't throw out of the loop.
- The receiver runs with **its own** policy, tool grants and memory scope (the phase 5 exit condition).
- The queue is SQLite: `agent_messages.status` goes `queued → delivered → processed`. Run children through the existing `TaskQueue` so `maxConcurrentTasks` applies.
- **Supervisor fan-out** (the design: Supervisor → Researcher ∥ Coder ∥ DevOps → Reviewer → Result). Independent children run concurrently. Steps touching the same file run sequentially. The Reviewer is a plan step that depends on the implementation steps.
- Remote agents (n8n, socket) are just another runner behind the same request/result contract, and they get traced the same way.
- Emit a `handoff` event `{from, to, messageId, childTaskId}`. The Agent Flow graph is drawn from these events.

## Tracing and the event bus

Tracing is required from day one (spec §34).

- `core/tracing.ts`: one `Tracer` per request. `tracer.span(kind, {agentId, taskId, label}, fn)` writes one `traces` row (`trace_id`, a monotonic `seq`, `status`, `duration_ms`, `data_json`), and on exit it finalises `trace_runs` (`total_ms`, `status`, `metrics_json` with the spec §38 metrics). Use `try/finally`, so an exception can never skip finalisation. Errors become `error` events.
- `core/eventBus.ts`: a tiny typed emitter with no `vscode` import. After each **successful** DB write, publish `RuntimeEvent`s: trace events, plus `agent.state`, `task.updated`, `plan.updated`, `file.changed`, `tests.updated`. Subscribers: the webview hosts (`webview-bridge`), the status bar, the chat participant, and the existing `RunEvent` callback. Write `RunEvent` as an adapter over the bus, not a parallel system.
- `label` is a single human sentence for the Agent Work feed. `data` holds the machine fields. Every event carries `agentId`, because the feed colours rows by agent.
- Update `agents.status` (the run state) at span boundaries: `thinking` in decide/LLM, `running` in tools, `delegating`, `waiting` for an approval or a child, `idle` at the end. The sidebar dots and "Agents: N running" read it.
- Provide `renderTraceText(traceId)` that reproduces spec §34's tree (REQUEST, GLOBAL ROUTE, LOCAL LAYA, MEMORY, JEV, TOOLS, CONTEXT, LLM, TOOL, TOTAL). Expose it through an `agentOrchestrator.showTrace` command that opens it in an untitled editor or output channel.
