---
name: laya-agent-dev
description: Entry point for building the Laya-per-Agent + JEV + SQLite agent runtime from laya_agent_implementation_spec_v2.md as a VS Code extension (TypeScript runtime in the extension host + React webviews + VS Code Extension API, with Bun as the install/build/test/package toolchain), with the UI from target/real_ui_design.png. Use this whenever work touches backend/src, webview-ui, package.json scripts or contributions, bun build/test/install, packaging the VSIX, the spec, the development phases, "what should I build next", the Definition of Done, or any cross-cutting change (orchestrator, agents, Laya, memory, JEV, tools, tasks, plans, webviews). Load it even when the user just says "continue the implementation" or "next phase".
---

# Laya agent runtime: development hub

This skill is the map. It holds the decisions that apply everywhere. Each subsystem has its own skill with the detail.

Sources of truth: [laya_agent_implementation_spec_v2.md](../../../laya_agent_implementation_spec_v2.md) (the "spec") and [target/real_ui_design.png](../../../target/real_ui_design.png).

**The spec's Python/FastAPI details are translated, not followed literally.** The target framework is **TypeScript + React webviews + VS Code Extension API**. Keep the spec's architecture, rules, schema, phases and Definition of Done. Where the spec says FastAPI, pydantic, aiosqlite or pytest, use the equivalents in the table below.

| Spec (Python) | This project (VS Code extension) |
|---|---|
| FastAPI app + `/api/v1/*` routes | extension host services, exposed to webviews through a typed `postMessage` protocol (`webview-bridge`) and to users through commands and the chat participant |
| SSE/HTTP client | `webview.postMessage` push events |
| `pydantic-settings` + `.env` | `contributes.configuration` (`agentOrchestrator.*`) + `context.secrets` for keys |
| aiosqlite, `data/runtime.db` | `node:sqlite` `DatabaseSync` at `context.globalStorageUri/runtime.db` (already in use) |
| Laya model loaded in-process | the Laya model (`convaiinnovations/laya`, a Python model) is served over HTTP. One shared `LayaHttpClient` per activation is "one shared Laya runtime" |
| pytest | `bun test` for the vscode-free core and the webview. `@vscode/test-cli` for extension integration (`runtime-tests`) |
| pip / uvicorn / scripts | **Bun** for install, scripts, bundling and tests (see "Toolchain: Bun" below) |
| `POST /api/v1/chat` | the `agentOrchestrator.chat` chat participant, the chat webview, and the `agentOrchestrator.runTask` command |

## What exists already (read before changing)

- `backend/src/extension.ts` is activation and wiring (≈400 lines). It is the composition root.
- `backend/src/core/`: `orchestrator.ts` (566 lines, the whole agent loop in one class), `decision.ts` (AgentDecisionEngine + rules fallback + `decisionMode`), `model.ts` (OpenAI-compatible and Anthropic providers), `tools.ts`, `taskQueue.ts`, `agentMessageBus.ts`, `types.ts`.
- `backend/src/integrations/layaClient.ts` is the working Laya HTTP client. The folder also has `n8nTransport.ts` and `socketTransport.ts` for remote agents.
- `backend/src/persistence/database.ts` holds `AgentDatabase`: the schema, ad-hoc migrations, and every query.
- `backend/src/vscode/` holds the UI adapters: `agentsTree.ts`, `chatWindow.ts`, `monitorView.ts` (webview view + panel loading `media/monitorView.*`, a **vanilla-JS early version of the design**), `panel.ts`.
- `desktop/` (Electron + Next.js renderer) and `frontend/` belong to an earlier desktop direction. **They are not the target.** Don't add features there, and don't delete them unless the user asks.

## Target layout

Grow the existing `backend/src` toward the spec's §5 module split. Move a file when you substantially change it, never in a mass move mixed with behaviour changes:

```
backend/src/
  extension.ts          composition root only: build services, register providers/commands, dispose
  shared/               protocol.ts + view-model types; imported by BOTH extension and webview (no vscode, node:* or bun:* imports)
  domain/               types, ids/refs, status vocabularies
  storage/              sqlite.ts (open + PRAGMAs + migration runner), migrations/NNN_*.ts, repositories/*.ts, vector/
  decision/             layaRuntime.ts (wraps integrations/layaClient), engine.ts, result.ts (gating), policies/*.ts
  core/                 orchestrator.ts (pipeline only), context.ts, tracing.ts, eventBus.ts, config.ts
  agents/ tools/ memory/ jev/ tasks/ models/ integrations/
  vscode/               everything that imports 'vscode': webview hosts, status bar, commands, chat participant, tree, config reader
webview-ui/             React source for all webviews → bundled by `bun build` to dist/webview/
```

**Layering rule.** Only `extension.ts` and `vscode/**` may `import "vscode"`. Everything else is plain TypeScript that runs under VS Code's Node in production and under `bun test` in tests. This keeps the runtime unit-testable without launching VS Code, and it keeps the spec's separation between domain, storage, decisions, orchestration and UI (§44.2). Known violations to fix when you touch them: `core/taskQueue.ts` and `core/agentMessageBus.ts` use `vscode.EventEmitter`/`Disposable`. Replace them with a tiny local emitter and disposable type.

Settings are read in `vscode/config.ts` and passed down as plain objects or getter functions. `extension.ts` already follows this pattern with `LayaHttpClient` and `OpenAICompatibleModel`.

## Platform constraints

- **Engine vs types.** `engines.vscode` is `^1.104.0`, but `@types/vscode` is 1.125. An API newer than 1.104 compiles and then fails at runtime for users on 1.104. Either pin `@types/vscode` to the engine version or bump the engine deliberately. Decide once, with the user.
- **Only bundled dependencies reach users.** `.vscodeignore` excludes `node_modules/**`, and `vsce package --no-dependencies` ships none. With `bun build` bundling the extension (below), pure-JS npm packages are fine because they get inlined. **Native modules** (`.node` binaries, e.g. node-pty) are not, because they can't be bundled and are compiled per platform and Electron version. Keep the extension host free of them.
- **`node:sqlite` is synchronous** and runs on the extension-host thread, which other extensions share. Keep queries indexed and small, use transactions for batches, and chunk long jobs (compression, decay passes) with `setImmediate` between chunks.
- **No new dependencies without asking.** Candidates you may propose: React + react-dom (required for the webviews), `@types/bun`, `@vscode/codicons` (icons that match VS Code), `@happy-dom/global-registrator` + `@testing-library/react` (webview tests), `@vscode/test-cli` + `@vscode/test-electron`.
- **Don't use** `@vscode/webview-ui-toolkit`: it is deprecated/archived. Build components with plain React + `--vscode-*` CSS variables.

## Toolchain: Bun

Bun (1.4.2 is installed; the WSL shell has no `node` on PATH) is the **development toolchain**: package manager, script runner, bundler, test runner, and the way `vsce` gets run.

**The shipped extension still runs on VS Code's bundled Node (Electron).** An extension host can't run on Bun. So:
- Code under `backend/src` and `webview-ui/src` may use `node:*` built-ins (the extension) and web APIs (the webview), but **never `bun:*` imports or `Bun.*` globals**. They work in `bun test` and then crash in VS Code. Only `*.test.ts(x)` files and build scripts may use Bun APIs.
- Enforce this with types. The main `tsconfig.json` excludes test files and does **not** include `bun-types`, so a stray `Bun.file()` in runtime code fails `tsc --noEmit`. A separate `tsconfig.test.json` adds `"types": ["bun"]` for tests.
- Verified: Bun 1.4.2 runs the existing `node:sqlite` `DatabaseSync` code unchanged, FTS5 included. Tests therefore exercise the same driver API as production. Bun's `node:sqlite` is Bun's own implementation, though, so the extension-host tests (`runtime-tests`) remain the final check on real Node.

Verified commands and the recommended `package.json` scripts, which replace the npm/tsc ones:

```jsonc
"scripts": {
  "build:ext":     "bun build backend/src/extension.ts --target=node --format=cjs --external vscode --sourcemap=linked --outdir dist",
  "build:webview": "bun build webview-ui/src/main.tsx --target=browser --format=esm --production --entry-naming [name].[ext] --asset-naming [name].[ext] --outdir dist/webview",
  "build":         "bun run build:ext && bun run build:webview",
  "watch:ext":     "bun run build:ext --watch",
  "watch:webview": "bun run build:webview --watch",
  "typecheck":     "tsc --noEmit -p . && tsc --noEmit -p webview-ui && tsc --noEmit -p tsconfig.test.json",
  "test":          "bun test ./backend/src ./webview-ui/src",   // bare `bun test` also picks up vscode-extension-samples/
  "test:ext":      "bunx vscode-test",
  "package":       "bun run typecheck && bun run build && bunx --bun vsce package --no-dependencies --allow-missing-repository --skip-license"
}
```

- `bun build` of the current `extension.ts` produces one ~158 KB CJS file whose only externals are Node built-ins and `vscode`. `package.json` `main` stays `./dist/extension.js`.
- `bun build` strips types without checking them, so `typecheck` (`bunx tsc`, TypeScript 5.9 is installed) must run in `package` and before calling work done.
- Because `bun build` bundles, the extension can't rely on `tsc` emitting per-file JS under `dist/`. `desktop/main.mjs` currently `require`s `../dist/core/*.js` and `../dist/persistence/*.js`. That legacy desktop path breaks once the build switches. Tell the user; don't silently patch or delete it.
- Don't add a `vscode:prepublish` script. `vsce` runs it through npm, which isn't installed. Build explicitly first, as `package` does.
- **Lockfile:** `bun.lock` is authoritative. `package-lock.json` also exists and will drift. Ask the user before deleting it.
- `postinstall` runs `node scripts/patch-node-pty.cjs`. That exists for the desktop app's node-pty, not the extension. Flag it to the user rather than rewriting it.
- F5 (Extension Development Host) needs `.vscode/launch.json`'s `preLaunchTask` to point at a task that runs `bun run build`. For watching, use a compound task in `.vscode/tasks.json` that starts `watch:ext` and `watch:webview` as two background tasks.

When adding webview-ui: add `webview-ui/**` to `.vscodeignore` (the source stays out of the VSIX), and make sure `dist/webview/**` is shipped.

## Which skill to load

| You are touching… | Load |
|---|---|
| schema, migrations, repositories, IDs, refs | `runtime-schema` |
| Laya client, policies, confidence gating, adding an agent profile | `laya-policies` |
| tools, selection, risk/approval, tool_runs, file changes | `tool-engine` |
| memories, JEV graph, conflicts, vector, hybrid retrieval | `memory-jev` |
| context builder, budget, compression, references | `context-engine` |
| orchestrator pipeline, LLM adapters, tasks/plans, delegation, tracing, event bus | `orchestration` |
| extension ↔ webview protocol, view-models, pushing live events | `webview-bridge` |
| React webviews, sidebar/panels, status bar, design fidelity | `workbench-ui` |
| checking any UI change visually (screenshots, themes, widths, script errors) | `ui-verify` |
| tests of any kind | `runtime-tests` |

## Phase order (spec §36, §43)

Don't start a phase while the current one is unstable. The spec treats this as a hard rule, because later phases amplify bugs in the core loop.

| Phase | Build | Exit condition, which a test must demonstrate |
|---|---|---|
| 0 Groundwork (this project) | versioned migrations, layering fixes (no `vscode` in core), trace runs + events, shared protocol skeleton | existing features still work; build/test scripts moved to Bun; `bun test` runs the core without VS Code |
| 1 Core runtime (P0) | shared Laya runtime, global + coder policies, tool registry, orchestrator pipeline, LLM adapter, tracing | one agent receives a message, makes a Laya decision, calls a tool, invokes the LLM, and saves the result |
| 2 Memory + JEV (P1) | memory types/extraction/retrieval, entities/relations, temporal conflict handling | coder reuses prior structured knowledge without replaying the conversation |
| 3 Context compression (P1) | budgeting, summaries, structured compression, tool-output refs | long conversations stay within a predictable budget |
| 4 Tasks + plans (P2) | tasks, plans, steps, planner, structured handoff | planner creates work, delegates, receives a result, updates the plan |
| 5 Multi-agent (P2) | researcher/reviewer/devops/documenter, communication queue, scoped memory | agents collaborate without sharing all tools/memory/context |
| 6 Vector (P3) | embedding + vector interfaces, no-op store, sqlite-vec | disabling vector breaks nothing |
| UI (P4) | React webviews for the design | the design renders from live runtime data |

The **first deliverable** is spec §41, run through the chat participant or chat webview: save → global Laya → coder/general → local Laya → context → tool → LLM → save → memory/JEV → reply. Because much of this already exists in `orchestrator.ts`, phase 1 here is mostly *restructuring into the pipeline + adding traces and tests*, not greenfield work.

UI work may start early against fixtures (`webview-bridge/references/ui-contract.md`), but it must not pull runtime features forward out of phase order.

## Working rules (spec §44)

1. Read the existing code before modifying it. Most subsystems have a first version in `orchestrator.ts` or `database.ts`.
2. Keep the layers separate (the layering rule above). Repositories hold SQL only. Services hold rules. The orchestrator sequences. `vscode/**` adapts.
3. Agent-specific behaviour belongs in policies and agent rows, not in `if (agent.id === "coder")` branches.
4. Add tests with every capability, and a trace event for every important decision.
5. When the path is clear: implement → test → fix → continue. When a decision is unclear: draft → recommend → ask the user.

## Anti-patterns to reject (spec §39)

One Laya client per agent · every tool schema to every agent · the entire history every turn · the vector store treated as memory · deleting raw history after summarising · every agent reading every memory · Laya confidence bypassing tool approval · the core coupled to the VS Code API (hence the layering rule) or to an external agent framework.

## Definition of Done for V1 (spec §42)

Verify each item with a test or trace:
- SQLite is the only required store, and vector can be fully disabled.
- One shared Laya client, with distinct per-agent policies.
- Tools are filtered per agent, and the LLM never gets all tools.
- Memory retrieval is selective.
- JEV entities and relations are stored and queried, and changed facts deactivate old relations.
- Tool outputs are stored and referenced by ID.
- Compression never deletes raw messages.
- Every request has an inspectable trace.
- The core runs without the VS Code API (standalone), and integrations are additive.

The headline metric (spec §38): **how often the runtime avoids calling the main LLM for trivial decisions.**
