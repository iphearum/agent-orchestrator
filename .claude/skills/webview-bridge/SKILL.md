---
name: webview-bridge
description: The typed message protocol between the VS Code extension host and the React webviews — shared protocol.ts types, request/response RPC over postMessage, pushed runtime events, the view-model builders (task detail, agent flow, work feed, files, tests, knowledge, health), webview host classes (WebviewViewProvider sidebar, per-task WebviewPanels, serializers), CSP/nonce/asWebviewUri HTML, visibility-aware batching, and validating webview input. Use this whenever you add data a webview needs, add a webview method or event, create or change a webview host in backend/src/vscode/, touch acquireVsCodeApi/postMessage code, or the user says "wire the UI to the runtime" / "the panel doesn't update".
---

# Webview bridge

Webviews are sandboxed iframes. They talk to the extension host only through `postMessage`. This skill defines that channel: its types, its methods and events, and the host-side classes. The view-model JSON shapes, with example values from the design, are in [references/ui-contract.md](references/ui-contract.md). Read the relevant section before adding or changing a method.

## Shared protocol (`backend/src/shared/protocol.ts`)

A single file, imported by both bundles: the extension (`bun build --target=node`) and `webview-ui` (`bun build --target=browser`, via the `@shared/*` tsconfig path). It must import none of `vscode`, `node:*` or `bun:*`, because it has to work in both the extension host and the browser sandbox.

```ts
export interface Methods {
  "health.get":            { params: void;                         result: HealthView };
  "workspaces.list":       { params: void;                         result: WorkspaceView[] };
  "agents.list":           { params: void;                         result: AgentView[] };
  "tasks.list":            { params: { status?: TaskStatus[]; limit?: number }; result: TaskListItem[] };
  "tasks.get":             { params: { taskId: string };           result: TaskView };
  "tasks.update":          { params: { taskId: string; patch: TaskPatch }; result: TaskView };
  "tasks.flow":            { params: { taskId: string };           result: FlowView };
  "tasks.events":          { params: { taskId: string; afterSeq?: number }; result: WorkEvent[] };
  "tasks.toolRuns":        { params: { taskId: string };           result: ToolRunView[] };
  "tasks.files":           { params: { taskId: string };           result: FileChangeView[] };
  "tasks.tests":           { params: { taskId: string };           result: TestReportView | null };
  "tasks.knowledge":       { params: { taskId: string };           result: KnowledgeItem[] };
  "tasks.metrics":         { params: { taskId: string };           result: MetricsView };
  "conversations.list":    { params: { limit?: number };           result: ConversationItem[] };
  "conversations.messages":{ params: { conversationId: string };   result: ConversationMessage[] };
  "toolRuns.approve":      { params: { toolRunId: string };        result: void };
  "toolRuns.reject":       { params: { toolRunId: string; reason?: string }; result: void };
  "chat.send":             { params: { conversationId?: string; agentId?: string; message: string }; result: { traceId: string; taskId?: string } };
  "ui.openTask":           { params: { taskId: string };           result: void };   // host opens/focuses the task panel
  "ui.openDiff":           { params: { fileChangeId: string };     result: void };   // native vscode.diff
  "ui.openFile":           { params: { path: string; line?: number }; result: void };
  "ui.openTerminal":       { params: void;                         result: void };   // native terminal
}

export type ToHost   = { kind: "request"; id: string; method: keyof Methods; params: unknown } | { kind: "ready"; surface: Surface };
export type ToWebview =
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { kind: "events"; events: RuntimeEvent[] }            // batched pushes
  | { kind: "init"; surface: Surface; context: { taskId?: string } };
export type Surface = "sidebar" | "task" | "overview" | "chat";
```

A method name is the contract. Renaming or reshaping one means updating both sides in the same change, plus `ui-contract.md`.

## Host side (`backend/src/vscode/webviews/`)

- `rpcRouter.ts`: a `Methods` handler map → calls **services** (view builders), never SQL directly. Every handler validates `params` with a hand-written guard. On failure it returns `{ok:false, error:{code:"bad_params"}}`.
- `views.ts`: builds view-models from repositories and services (`TaskView` composes task + assignees + plan/progress + counts). Don't make the webview stitch five calls together to render one panel. It has no `vscode` import, so it is unit-testable.
- `webviewHost.ts`: shared plumbing. It builds the HTML, wires `onDidReceiveMessage` → the router, subscribes to the runtime `eventBus`, and handles disposal.
- `sidebarView.ts`: a `WebviewViewProvider` for the Activity Bar container (surface `sidebar`).
- `taskPanels.ts`: a `Map<taskId, WebviewPanel>`. `ui.openTask` reveals an existing panel or creates one titled `Task #12`. Also register a `WebviewPanelSerializer`, so panels survive reloads (add the `onWebviewPanel:<viewType>` activation event), and persist the `taskId` through webview state.
- The existing `monitorView.ts` / `chatWindow.ts` / `panel.ts` load vanilla HTML from `media/`. Migrate them onto `webviewHost` as their React surfaces land (`workbench-ui`).

### HTML and CSP

Every webview uses the same template, which follows the pattern already in `monitorView.ts`:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  img-src ${cspSource} https: data:; style-src ${cspSource}; font-src ${cspSource};
  script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asWebviewUri(dist/webview/assets/index.css)}">
<div id="root" data-surface="task"></div>
<script nonce="${nonce}" type="module" src="${asWebviewUri(dist/webview/assets/index.js)}"></script>
```

- `localResourceRoots: [dist/webview]` (plus `media` while legacy views remain). Generate a fresh random nonce per render.
- No inline scripts and no `unsafe-eval`. React's `element.style` updates are fine under this CSP. Prefer classes anyway.
- One bundle (`dist/webview/main.js` + `main.css`, fixed names from `bun build --entry-naming [name].[ext]`) serves every surface. The `data-surface` attribute picks the root component.

### Pushing events

- Subscribe once per host to `eventBus` (`orchestration`). Filter per panel: a task panel only receives events whose `taskId` is its task or a descendant.
- **Batch**: queue events and flush every ~100 ms as one `{kind:"events"}` message. A tool loop can emit dozens of events per second.
- **Visibility**: while a view is hidden, don't post; mark it stale instead. On `onDidChangeVisibility` / `onDidChangeViewState` → visible, the webview refetches via `tasks.events?afterSeq=lastSeq`. Avoid `retainContextWhenHidden` except on the task panel, and only if the refetch proves too slow. It keeps a whole renderer alive.
- Handshake: the webview posts `ready` → the host replies `init` (surface + context). Pushes start only after `ready`, because messages posted before the webview script loads are lost.

## Webview side (`webview-ui/src/bridge.ts`)

```ts
const vscode = acquireVsCodeApi();              // call exactly once per webview
export function call<M extends keyof Methods>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>
export function onEvents(fn: (events: RuntimeEvent[]) => void): () => void
export const uiState = { get: () => vscode.getState(), set: (s) => vscode.setState(s) }  // tab, scroll, collapsed sections
```

Pending calls are keyed by `id` with a timeout (e.g. 15 s → reject). A pushed `task.updated` replaces cached data; other event kinds patch it (see the event list in `ui-contract.md`).

## Trust boundary

The webview renders LLM and agent output, so treat it as **less trusted than the host**:
- Validate every request's params on the host. File paths from `ui.openFile` must resolve inside the workspace.
- Render agent text as text. Markdown goes through markdown-it with `html: false` (already vendored in `media/`), and never through `dangerouslySetInnerHTML` of raw model output.
- **Approvals of risk-3 tools (and risk-2 ones in `ask` mode) are confirmed with a native modal** (`window.showWarningMessage(..., {modal:true})`) even when they start from a webview button. A script injected into a webview must never be able to approve a destructive action on its own.

## Status bar and chat are not webviews

The status bar items (Agents running, Tasks active, Laya, SQLite) are native `StatusBarItem`s that subscribe to the same `eventBus` + `health.get` builder. The `@orchestrator` chat participant streams `RunEvent`s through `ChatResponseStream`. Both reuse `views.ts`, so they never disagree with the webviews.
