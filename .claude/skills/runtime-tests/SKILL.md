---
name: runtime-tests
description: Testing strategy for the VS Code agent runtime — bun test (bun:test) for the vscode-free core (temp-dir node:sqlite DB, scripted FakeLaya and FakeLLM, fake workspace/approval ports, trace assertions), React webview component tests with happy-dom against fixtures, @vscode/test-cli integration tests in the Extension Development Host, the eight required regression scenarios (auth debugging, repo search, schema change, fact replacement, delegation, tool failure, low-confidence Laya, vector-disabled) and phase-exit tests. Use this whenever you write or run tests, finish a phase, fix a runtime bug, add a migration, or the user asks "does it work", "add tests" or "verify phase N".
---

# Runtime tests

Spec §44 requires tests with every capability, and a phase exit condition (§36) counts only when a test demonstrates it. The runtime is nondeterministic at its edges (Laya, the LLM, tools, VS Code), so this skill rests on two techniques: **replace the edges with scripted fakes** and **assert on traces**.

There are no tests in the repo today. Setting them up is part of phase 0.

## Tooling

| Layer | Runner | Why |
|---|---|---|
| Core runtime (everything without `import "vscode"`) | **`bun test`** (`import { describe, it, expect, mock, beforeEach } from "bun:test"`) | built in, runs TypeScript directly, Jest-compatible, fast. No extra runner dependency |
| Webview components | `bun test` + `@happy-dom/global-registrator` (preloaded) + `@testing-library/react` | render surfaces from fixtures in a DOM |
| Extension integration | **`@vscode/test-cli` + `@vscode/test-electron`**, launched with `bunx vscode-test` | activation, commands, webview hosts, status bar in a real Extension Development Host on VS Code's own Node (see `vscode-extension-samples/helloworld-test-cli-sample`) |

- The new devDependencies are `@types/bun`, happy-dom's registrator, testing-library, and the VS Code test packages. Ask the user once before adding them.
- `bunfig.toml`:
  ```toml
  [test]
  preload = ["./webview-ui/test/happydom.ts"]   # only if webview tests exist; registers GlobalRegistrator
  coverageSkipTestFiles = true
  ```
- Scripts: `test` (`bun test`), `test:watch` (`bun test --watch`), `test:ext` (`bunx vscode-test`). `bun test --coverage` for coverage.
- **`bun test` does not type-check.** Always run `bun run typecheck` (`tsc --noEmit` over the extension, the webview and `tsconfig.test.json`) alongside the tests before reporting success.
- **Bun vs production runtime.** Bun 1.4.2 runs the existing `node:sqlite` `DatabaseSync` code, FTS5 included, so the core tests use the same driver API that ships. But Bun implements `node:sqlite` itself, while VS Code uses real Node. Differences can hide there: `get()` on no row returns `undefined` in `node:sqlite` (`null` in `bun:sqlite`; compare with `== null` to be safe), as can bigint handling and error messages. That's why the extension-level smoke test runs migrations and a pipeline turn on real Node.
- Test files may use `bun:test` and `Bun.*`. Runtime code may not (see `laya-agent-dev` → Toolchain). If a test only passes because of a Bun API inside runtime code, that is a bug.

Unit-testing the core depends on the layering rule (`laya-agent-dev`): a module that imports `vscode` can't load under `bun test`. If a test needs `vscode`, the code under test belongs behind a port. Don't mock the `vscode` module with `mock.module("vscode", …)` to get around this. That hides the layering violation instead of fixing it.

## Layout

```
backend/src/**/__tests__/*.test.ts     unit + integration tests next to the code (bun test)
backend/test/fakes.ts                  FakeLaya, FakeLLM, FakeWorkspacePort, FakeApprovalPort, RecordingEventBus
backend/test/fixtures/workspace/       small repo (e.g. src/auth/login.py with the null-check bug) copied to a temp dir per test
backend/test/regression/*.test.ts      the 8 scenarios, one file each
webview-ui/src/**/*.test.tsx           component tests using src/fixtures
test/ext/*.test.ts                     @vscode/test-cli suites
```

## Fakes and fixtures

- **DB:** `mkdtemp` → `new AgentDatabase(tmpDir)` (the constructor already takes a directory) → real migrations + seeds. Never hand-create tables: schema drift the tests don't see is a missed bug. Close the DB and remove the directory in `afterEach`.
- **FakeLaya:** implements the transport interface of `layaRuntime.ts`. You script answers per profile: `laya.on("global").answer({ agent: ["coder", .96], needs_deep_reasoning: [false, .9] })`. Support `.fail()` to exercise the circuit breaker and fallback. It records the state it was sent, so tests can assert that the state is small and truncated.
- **FakeLLM:** implements `LLMProvider`. It takes a queue of scripted turns (`toolCall("search_workspace", {...})`, `final("…")`) and records the `messages` + `tools` of each call. That is how you assert "at most 3 tool schemas" and "no raw tool output in the context".
- **Ports:** `FakeWorkspacePort` backed by the temp fixture directory. `FakeApprovalPort` answers approve/reject from a script and records its prompts.
- **Clock and IDs:** inject `now()` and `newId()` so traces and timestamps are deterministic.

## Assert on traces

```ts
const trace = await traces.load(result.traceId);
expect(trace.first("tools")!.data.selected.length).toBeLessThanOrEqual(3);
expect(trace.first("decision", { profile: "coder" })!.data.answers.tool.mode).toBe("execute");
expect(trace.has("vector")).toBe(false);
```

If a behaviour can't be asserted from its trace, the trace event is missing. Add it (spec §44.9).

## Required unit tests (spec §37)

- Agent routing: criteria come only from enabled agents.
- Confidence gating: exactly 0.65 and 0.90, per question.
- Memory filtering: scope, workspace, type, active.
- Graph conflicts: `one` vs `many` predicates; identical facts reinforce instead of churning (a regression guard for the old `upsertRelation`).
- Tool permissions: the full table of risk 0–3 × approvalMode ask/approve/full × granted/not × decision mode.
- Task transitions: illegal ones throw.
- Plan transitions: a single active plan; replan supersedes.
- Context budget: never exceeded; gated-off sections are omitted.
- Migrations: 002 applies on a DB built by the **old** `migrate()` baseline with sample rows, and the data survives.
- Webview bridge: every `Methods` handler rejects bad params.

## Integration test: the first deliverable (spec §41)

A core-level test (no VS Code) that runs the orchestrator end to end: a user message is saved → the global route picks coder → the coder policy runs → memory/JEV are used according to the decision → context is built → a tool runs (stored with a `tool://` ref) → the LLM is called with ≤ 3 schemas → the response is saved → memory/JEV are updated → the result has the §33 shape with a `traceId`, and the `trace_runs` row is `completed`. This is the phase 1 exit test. Keep it green.

Plus one extension-level smoke test (`test:ext`): activation succeeds, the commands are registered, and the sidebar view and a task panel resolve and answer `health.get`.

## Regression scenarios (spec §37)

| # | Scenario | Setup | Must prove |
|---|---|---|---|
| 1 | Auth debugging | fixture `src/auth/login.py`; Laya → coder, tool=search_code | tool run stored with a ref; the LLM saw the summary only; `file_changes` row with a diff after the edit |
| 2 | Repository search | a query for a symbol | only search/read schemas offered; risk-0 tool ran without an approval prompt |
| 3 | Schema change | message describing a new column | JEV entity + relation; `task_entities` link |
| 4 | Old fact replaced | seed `gateway uses_port 8000`; "now runs on 8080" | old relation `active=0` + `valid_to`; exactly one active `uses_port` |
| 5 | Delegation | coder policy delegate=planner at execute confidence | child task + request/result `agent_messages`; guards hold; the receiver used only its own tools |
| 6 | Tool failure | fake tool throws | `tool_runs.status=failed`; the loop continued; the agent saw an error summary; trace `completed` |
| 7 | Low-confidence Laya | every answer 0.4 | mode `reason`; LLM invoked; memory/graph retrieved anyway; no auto-delegation |
| 8 | Vector disabled | vector off | the pipeline succeeds; `NoVectorStore`; zero embedding calls; no `vector` event |

Each runtime bug fix adds a scenario that fails before the fix.

## Phase-exit tests

| Phase | Test |
|---|---|
| 0 | `bun test` runs the core with no VS Code; `bun run typecheck` is clean; migration 002 upgrades an old DB; `bunx vscode-test` smoke test passes on real Node |
| 2 | turn 2 of a new conversation answers from memory/JEV with no earlier messages in the LLM context |
| 3 | a 200-turn scripted conversation stays within budget on every turn; the message count is unchanged |
| 4 | planner creates a plan → delegates a step → receives the result → the step completes and progress updates |
| 5 | two agents collaborate; each LLM call has only its own tools and scoped memories |
| 6 | toggling vector on and off gives equivalent answers via the lexical fallback |

## UI checks

Component tests render each surface from `fixtures/` and cover the label maps, the Complete button's disabled state, the Approve/Reject rows, and the empty and error states. Visual checks use the `ui-verify` skill: scripted renders of the chat window and the React surfaces in light, dark and high-contrast themes and at narrow widths, a script-error dump, and a look at every screenshot.

## Reporting

Quote the real summary line from `bun test` (e.g. `42 pass, 0 fail`) and from vscode-test, plus the typecheck result, and name each failing test with its assertion message. If a layer could not run (e.g. vscode-test needs a display or a VS Code download that isn't available), say so plainly. Never call a phase complete while one of its exit tests is failing, skipped or unrun.
