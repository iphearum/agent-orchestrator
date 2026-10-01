---
name: workbench-ui
description: Build the Agent Orchestration UI from target/real_ui_design.png as React webviews inside the VS Code extension — the sidebar WebviewView (workspace, nav, agents, active tasks, recent conversations), the per-task WebviewPanel (task header, Agent Flow graph, Agent Work feed, code diff/test results/agent conversation, task details column), the Overview panel, and native StatusBarItems — styled with --vscode-* theme variables and wired through the webview bridge. Use this whenever you touch webview-ui/, media/*.html|css|js webviews, viewsContainers/views contributions, status bar items, or the user mentions the design, a region by name ("agent flow", "work feed", "task details", "status bar"), theming, or "make it look like the mockup".
---

# Workbench UI (React webviews + native VS Code surfaces)

Target: [target/real_ui_design.png](../../../target/real_ui_design.png). Open it with the Read tool before visual work, and compare against it afterwards. [references/design-spec.md](references/design-spec.md) maps every region to a VS Code surface and lists the theme tokens, agent colours, status visuals and data sources. Read the section for the region you are building. The data shapes are in [../webview-bridge/references/ui-contract.md](../webview-bridge/references/ui-contract.md).

## Principles

- **Native first, webview where the design needs it.** The title bar, activity bar, editor tabs, terminal, diff editor and status bar in the mockup *are* VS Code. Use the real thing (`viewsContainers`, `WebviewPanel` tabs, `StatusBarItem`, `vscode.diff`, `createTerminal`), and build React only for the content that has no native equivalent.
- **Theme variables, never hex.** The mockup is Dark Modern. Every colour maps to a `--vscode-*` variable (design-spec §2), so light, high-contrast and custom themes just work.
- **The webview is a view.** It holds no business logic. It renders view-models from the host (`webview-bridge`) and sends intents back (`tasks.update`, `toolRuns.approve`, `ui.openDiff`).

## What exists

- `backend/src/vscode/monitorView.ts` loads `media/monitorView.html|css|js`, a **vanilla-JS early version of this design** (sidebar brand, workspace switcher, nav). Mine it for behaviour and copy, then replace it with the React surfaces.
- `backend/src/vscode/chatWindow.ts` is a chat webview with a composer, model picker and approval modes. It stays working; port it to React last.
- `agentsTree.ts` is the native "Agents" tree. It gets superseded by the sidebar webview, so remove it once the webview is at parity.
- `desktop/renderer-next` (Next.js/Electron) and `frontend/` are **not** the target. Borrow ideas, not code paths.
- Reference samples in the repo: `vscode-extension-samples/webview-sample`, `webview-view-sample`, `webview-codicons-sample`.

## Project setup (`webview-ui/`)

```
webview-ui/
  tsconfig.json      jsx react-jsx, lib DOM+ES2022, moduleResolution bundler, strict, noEmit;
                     paths { "@shared/*": ["../backend/src/shared/*"] }  ← bun build resolves tsconfig paths too
  dev.html           browser dev page for the fixture loop (not shipped)
  src/main.tsx       read document.getElementById("root").dataset.surface → mount SidebarApp | TaskApp | OverviewApp | ChatApp
  src/bridge.ts      acquireVsCodeApi wrapper (webview-bridge); falls back to fixtures when not in VS Code
  src/theme.css      token aliases (design-spec §2)
  src/agentColors.ts
  src/surfaces/      sidebar/, task/, overview/, chat/
  src/components/    Tabs, Pill, Chip, Avatar, StatusDot, Toggle, Codicon, SplitPane, EmptyState, ErrorState
  src/fixtures/      JSON from ui-contract.md
```

**Bundler: `bun build`, not Vite.** Bun transpiles TSX/JSX natively, bundles CSS imported from TSX into a sibling `.css`, and copies assets such as fonts:

```bash
bun build webview-ui/src/main.tsx --target=browser --format=esm --production \
  --entry-naming [name].[ext] --asset-naming [name].[ext] --outdir dist/webview
# → dist/webview/main.js, main.css, fonts — stable names the webview host references
```
- Use `--production`, not just `--minify`: it sets `NODE_ENV=production`, which drops React's development build (0.60 MB → 0.37 MB).
- Use fixed, hash-free names, because the host builds the `<script>`/`<link>` URLs itself. Webview caching isn't an issue: each extension version gets a fresh resource URI.
- One bundle serves every surface, selected by `data-surface`. Only add `--splitting` if the bundle gets big enough to justify loading chunks on demand; the host HTML must then allow them through `asWebviewUri`.
- JSX needs no plugin: set `"jsx": "react-jsx"` in `webview-ui/tsconfig.json`. `bun build` doesn't type-check, so `bun run typecheck` covers `webview-ui` too.
- The existing `vite` devDependency is no longer needed for the extension. Leave its removal to the user (the desktop app may still use it).

Dependencies: React and react-dom are needed. They're bundled into `dist/webview`, so `--no-dependencies` packaging is fine. Propose `@vscode/codicons` for icons (see the codicons sample; import its CSS from `main.tsx` so its font lands in `dist/webview`, and allow `font-src`). **Ask before adding them** (`bun add react react-dom`, `bun add -d @types/react @types/react-dom`), and before adding Tailwind or a state library. Plain CSS files (`import "./theme.css"`) + React context/`useSyncExternalStore` are enough. Don't use `@vscode/webview-ui-toolkit`: it is deprecated.

Add `webview-ui/**` to `.vscodeignore`.

**Fast inner loop:** `bun --port=5174 webview-ui/dev.html` starts Bun's dev server, with bundling and hot reload, in a normal browser. Put the flag **before** the file, or it is ignored. The default port, 3000, collides with the desktop app's Next.js dev server. `bridge.ts` detects that `acquireVsCodeApi` is missing and serves the fixtures, plus a fake event ticker that replays `tasks.events`. `dev.html` should also define fallback values for the `--vscode-*` variables (a copy of Dark Modern's), because outside VS Code they don't exist. That makes layout work quick. Then check it in the Extension Development Host (F5, running `bun run build` or the watch tasks) for real theming and messaging.

## Surfaces to build (in this order)

1. **Status bar** (native, `vscode/statusBar.ts`): 4 items from `health.get` + events. It is small, highly visible, and proves the event bus end to end.
2. **Task panel** (surface `task`): the header, Flow (Agent Flow first), Work (Agent Work first), the bottom split, and the details column. This is the heart of the design.
3. **Sidebar** (surface `sidebar`): it replaces the Agents tree + Monitor views. Update `package.json` `views` (type `webview`) and the container title.
4. **Overview panel** (surface `overview`): a workspace dashboard. Port the existing monitor overview (agent network, task counts, recent traces).
5. **Knowledge / Memory / Tools / Agents panels**: opened from the sidebar nav, backed by new bridge methods as each phase lands.
6. **Chat surface**: port `chatWindow.ts` last, keeping feature parity (models, approval mode, attachments).

For each surface: build it against fixtures → wire it through the bridge → compare with the PNG → delete the legacy code it replaces.

## Implementation rules

- **State:** one store per surface, fed by initial `call()`s + batched pushes. Event kinds patch the store (design-spec / ui-contract list). Persist UI-only state (active tabs, split sizes, collapsed sections, Group by Agent, Auto-scroll) through `vscode.setState`, so it survives tab switches and reloads.
- **Agent colours:** only through `agentColors.ts` + a `--agent` CSS variable. Never build dynamic class names from the colour key.
- **Labels:** map raw statuses to wording only via the design-spec §4 tables. The host sends `active`, and the UI says "In Progress".
- **Agent Flow:** plain SVG, using host-computed `layer`s. Edges take the source agent's hue. Pan and zoom via a transform. Re-layout only when the node set changes, not on every state update.
- **Feed performance:** virtualise past ~500 rows. Coalesce the renders caused by a batch into one update.
- **Markdown:** use the vendored markdown-it with `html:false` for agent text. Never inject raw model output as HTML.
- **Accessibility:** tabs use `role=tablist/tab/tabpanel` with arrow keys. Toggles are real buttons or checkboxes. Every dot and colour has an `aria-label` or text. Honour `prefers-reduced-motion` for the spinners and pulses. Everything must be reachable by keyboard.
- **Empty and error states** everywhere: no workspace, no tasks, runtime error, "Laya: offline". Never leave a blank panel.

## Verify

- `bun run typecheck` and `bun run build` succeed for both the extension and the webview bundle.
- **Load the `ui-verify` skill and follow it.** Screenshot the changed surfaces in light, dark and high-contrast themes and at narrow widths, run `--dump` for script errors, and look at every PNG. Compare the task panel region by region with the design PNG: layout proportions, spacing, agent hues, and the flow-graph shape.
- Then F5 for what only VS Code can show: real theme colours, native dialogs, drag handles.
- Switch to a light theme and a high-contrast theme. Everything must stay legible, because nothing is hardcoded.
- Check that the webview DevTools console (`Developer: Open Webview Developer Tools`) shows no CSP violations.
