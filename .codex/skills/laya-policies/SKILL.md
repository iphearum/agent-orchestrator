---
name: laya-policies
description: The shared Laya decision runtime (LayaHttpClient) and per-agent Laya policies for the VS Code agent runtime — global/supervisor routing, coder, researcher, planner, reviewer, devops, documenter, general — plus confidence gating (execute/enrich/reason), the Laya HTTP contract, circuit breaker and no-Laya/rules fallback. Use this whenever you touch backend/src/core/decision.ts, backend/src/integrations/layaClient.ts, backend/src/decision/, the agentOrchestrator.laya* settings, add or change an agent profile or policy question, tune thresholds, or debug "why did it route to that agent / pick that tool" — even if the user only says "add a DevOps agent" or "routing is wrong".
---

# Laya runtime and policies

Laya is a **decision layer, not the orchestrator** (spec §2.2). It answers small constrained questions fast: which agent, whether memory/graph/vector retrieval is needed, which tool category, whether to delegate, whether to continue or replan, whether the main LLM is needed. It never executes tools, persists state, mutates memory, authorises anything, or writes long-form reasoning. If a question is open-ended, it belongs to the main LLM.

## What exists

- `integrations/layaClient.ts`, `LayaHttpClient`: HTTP transport, validation, a 30 s circuit breaker, `status`, `ping()`. **But it also builds the questions itself**, sending the same yes/no set to every profile plus a hardcoded tool list per profile.
- `core/decision.ts`: `AgentDecisionEngine` (calls Laya, maps answers, falls back), the `LayaRuntime` rules baseline, and `decisionMode()`.
- Settings: `agentOrchestrator.layaEnabled`, `layaEndpoint`, `layaTimeoutMs` (default 1500), `layaFallbackMode` (`none`|`rules`), `automaticExecutionConfidence` (0.90), `contextEnrichmentConfidence` (0.65). The secret is `agentOrchestrator.laya.apiKey`. The commands are `configureLayaKey` and `testLaya`.
- `extension.ts` creates **one** `LayaHttpClient` per activation. That satisfies "one shared Laya runtime" (spec §10). Keep it that way, and never create a client per agent or per request.

## Target structure (`backend/src/decision/`)

```
layaRuntime.ts   // decide(state, questions) -> answers. Wraps LayaHttpClient; transport only, no policy knowledge
engine.ts        // AgentDecisionEngine: profile -> policy (built with runtime context) -> runtime -> DecisionResult
result.ts        // DecisionValue/DecisionResult + gating helpers (pure functions, heavily unit-tested)
fallback.ts      // 'none' and 'rules' fallbacks (move the existing baseline here)
policies/        // global.ts, coder.ts, researcher.ts, planner.ts, general.ts (+ reviewer/devops/documenter later)
```

The refactor that matters most: **move question-building out of `LayaHttpClient` into policy modules.** Policies are data plus a small builder for the criteria that depend on the runtime. The client just sends what it is given. That is the whole point of "each agent gets its own Laya policy" (spec §2.3), and today every profile gets the same questions.

## HTTP contract (keep, from the existing client)

- `POST {layaEndpoint}` (path used so far: `/v1/systemone`), body `{ state, questions }`, optional `Authorization: Bearer <key>`.
- Response `{ answers: { [key]: { choice, confidence | probability } }, routing? }`. Confidence = `confidence` ?? `probability` ?? 0.5, clamped to [0, 1]. A response without `answers` is an error.
- Spec-style `noul` questions go on the wire as `{type:"choice", criteria:{yes, no}}`, and `choice === "yes"` means true. Keep this translation inside `layaRuntime.ts`, so policies can use the spec's `noul` syntax. Switch to native `noul` only after confirming the endpoint supports it. The spec says to follow the current `convaiinnovations/laya` API, so check its docs or ask; don't guess.
- HTTPS is required, except for localhost/127.0.0.1/::1. The timeout is clamped to 100 ms–60 s. After a failure, skip Laya for 30 s. Reset the circuit when the endpoint setting changes.
- Truncate the state: message ≤ 6000 chars, recent context ≤ 3000, ≤ 20 tools, ≤ 20 entities, ≤ 30 agent descriptors. The state must stay small (spec §13).
- `status` → the status bar item "Laya: online / offline / fallback" (see `workbench-ui`).

## Policies (spec §11–12)

Question types: `noul` (a yes/no answer with confidence) and `choice` (`criteria: {key: description}`).

- **global** (Supervisor): `agent` choice + `needs_deep_reasoning`.
- **coder**: `needs_memory`, `needs_graph`, `needs_vector`, `tool` (search_code / read_file / shell / database / git / none), `delegate` choice (self / researcher / planner), `needs_llm`.
- **researcher**: `retrieval_source` (local_memory / graph / vector / web), `needs_memory`, `needs_graph`, `needs_llm`.
- **planner**: `continue_plan`, `replan`, `delegate` (coder / researcher / planner), `needs_llm`.
- **general**: `needs_memory`, `needs_graph`, `tool`, `needs_llm`.

Two gaps in the existing code to close deliberately:
1. **Tool categories.** The existing client uses `workspace_read / workspace_write / memory / knowledge_graph / planning / agent_communication / shell`. That list mixes retrieval and delegation into "tool", which the spec keeps as separate questions. Recommendation: adopt the spec's categories, with `tools.category` linking each concrete tool to one category (`tool-engine`). Confirm this with the user, because it changes routing behaviour.
2. **`delegate` is yes/no today.** The spec makes it a choice of target. Use the choice, and build its criteria from the enabled agents the current agent may delegate to.

**Build criteria dynamically when the valid set depends on runtime state.**
- `agent` = enabled agent rows (`id → "name: description; skills"`), capped at ~20, pre-ranked by keyword overlap as the existing client already does.
- `tool` = only the categories for which this agent holds a granted, enabled tool, plus `none`. The existing code also adds `shell` only when `run_command` is available. Keep that behaviour.
- `delegate` = only allowed targets.

An option that can't be honoured should never be offered.

## Agents in the design → profiles

| Agent | laya_profile | Phase | Notes |
|---|---|---|---|
| Supervisor | global | 1 | The personification of routing + fan-out. It replaces or absorbs the existing `lead` agent; migrate `lead` rather than keeping two coordinators |
| Coder | coder | 1 | |
| General | general | 1 | Routing fallback. May be hidden in the UI |
| Planner | planner | 4 | |
| Researcher | researcher | 5 | |
| Reviewer | reviewer (new) | 5 | Draft: `needs_graph`, `verdict` (approve / request_changes / escalate), `needs_llm` |
| DevOps | devops (new) | 5 | Draft: `tool` (shell / git / database / none), `needs_llm`. Every tool it has is risk ≥ 2 |
| Documenter | documenter (new) | 5+ | Draft: `needs_memory`, `needs_graph`, `needs_llm` |

Show new policies to the user before wiring them in (draft → recommend → ask).

**Adding a profile:** a policy module + registry entry → a seed/agent row (`laya_profile`, `color`, `can_delegate`, `enabled`) + tool grants → map every answer key to an action in `result.ts` (an unmapped question wastes Laya latency) → unit tests with a fake runtime.

## Fallback

- `none` (default): keep the requested/root agent, all retrieval flags false, `needs_llm=true`, tool `none`, confidence 1, `source:"none"`.
- `rules`: the existing keyword baseline, `source:"rules"`.

Every `AgentDecision` carries `source` and `fallbackReason`, and the trace shows both. A silent fallback looks exactly like a bad Laya decision.

## Confidence gating (spec §15)

`decisionMode(confidence, auto, enrich)` → `execute` (≥ auto) · `enrich` (≥ enrich) · `reason` (below). Apply it **per question**. The spec leaves the semantics open, so these are the recommended defaults. Keep them in `result.ts` as the only place that interprets modes:

| Question | execute | enrich | reason |
|---|---|---|---|
| global `agent` | route to it | route to it, log the runner-up | route to general/root; the LLM may delegate |
| needs_memory / needs_graph | follow the value | retrieve anyway (a SQLite lookup is cheap) | retrieve anyway |
| needs_vector | follow the value | skip unless lexical search found nothing | skip |
| tool | that category's tools (1–3) | top 2–3 eligible categories | the eligible tools, capped at 3 |
| delegate | honour it (guards still apply) | stay self, note it in the trace | stay self |
| needs_llm = false | answer without the LLM | call the LLM | call the LLM |

**Confidence never authorises anything.** A 0.99 decision to run a shell command still goes through the tool executor's approval policy (spec §15, §35). The one place confidence plays a role is the risk-1 auto-execution rule, and `tool-engine` owns that rule.

## Trace

Emit one `decision` event per policy call: profile, source, each answer (`value`, `confidence`, `mode`), latency, and the fallback reason. The Agent Work feed and the trace view both read it.
