# Workbench design spec: target/real_ui_design.png → VS Code

The design is a VS Code window running this extension (Dark Modern theme). This document maps each region to the VS Code surface that implements it, the theme tokens, and the data behind it. The colours in the PNG are simply the Dark Modern values of the tokens below. Use the `--vscode-*` variables and never hardcode hex, so light and high-contrast themes work for free.

## Contents
1. Region → surface map
2. Theme tokens (CSS variables)
3. Agent identity colours
4. Status vocabulary → visuals
5. Region details
6. Typography and density

---

## 1. Region → surface map

```
┌ A Title bar / menu / command center ───────────────────── native ─┐
│B│ C Sidebar                │ D Editor tabs: "Overview" "Task #12"  native tabs of WebviewPanels │ J Details│
│ │ WebviewView              │ E Task header        ┐                                              │ (task    │
│A│ agentOrchestrator.sidebar│ F Flow panel         │ Task WebviewPanel (surface "task")           │  panel   │
│c│                          │ G Work panel         │                                              │  right   │
│t│                          │ H Code│Tests│Convers.┘                                              │  column) │
├─┴──────────────────────────┴────────────────────────────────────────────────────────────────────┴──────────┤
│ K Status bar: git (native) … "Agents: 5 running" "Tasks: 1 active" "Laya: online" "SQLite: connected" = StatusBarItems │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Region | Implementation |
|---|---|
| A title bar, menu, command center | native. Nothing to build |
| B activity bar | `viewsContainers.activitybar` id `agentOrchestrator` (exists). Rename its title to "Agent Orchestration". The icon must be a monochrome SVG (`media/agents.svg`) |
| C left sidebar | one React `WebviewView` (surface `sidebar`) replacing the current `agentOrchestrator.agents` tree + `agentOrchestrator.monitor` views. See the alternative below |
| D editor tabs | native. Each is a `WebviewPanel` (`Overview` = surface `overview`, `Task #12` = surface `task`) |
| E, F, G, H | inside the task panel |
| J right details | the right column of the task panel, by default (see the note below) |
| K status bar | native `StatusBarItem`s, right-aligned, each with a codicon, tooltip and click command |
| H "Terminal" tab | opens or focuses a **native** terminal (`ui.openTerminal`). Don't embed xterm in a webview |
| H "Code Changes" | an inline React diff + an "Open in diff editor" button → native `vscode.diff` |

**Sidebar alternative.** Native views (TreeViews for Active Tasks and Recent Conversations, with `view/title` "+" actions) give native collapse, keyboard handling and accessibility for free. However, a TreeView can't render the design's two-line agent rows with coloured avatars and status dots, or the workspace dropdown. The existing `monitorView.html` already chose a webview sidebar, so the default here is one webview. Confirm with the user before building.

**Details column (J).** In the design it sits beside the editor, as if in the secondary side bar. Only contribute it as a separate view in the secondary side bar after verifying that the target VS Code version (see `engines.vscode`) supports that contribution location. Otherwise, render it as the task panel's right column, which is always possible.

## 2. Theme tokens

Define aliases once in `webview-ui/src/theme.css`, and use only the aliases in components:

| Alias | VS Code variable | Used for |
|---|---|---|
| `--wb-canvas` | `--vscode-editor-background` | task panel background |
| `--wb-sidebar` | `--vscode-sideBar-background` | sidebar webview |
| `--wb-surface` | `--vscode-editorWidget-background` | cards, flow nodes, message bubbles |
| `--wb-raised` | `--vscode-list-hoverBackground` | hovered rows |
| `--wb-border` | `--vscode-panel-border` (fallback `--vscode-widget-border`) | 1px dividers, card borders |
| `--wb-text` | `--vscode-foreground` | body |
| `--wb-text-strong` | `--vscode-editor-foreground` | titles, names |
| `--wb-muted` | `--vscode-descriptionForeground` | subtitles, timestamps, tool names |
| `--wb-accent` / `-fg` / `-hover` | `--vscode-button-background` / `-foreground` / `-hoverBackground` | Complete button |
| `--wb-selected` / `-fg` | `--vscode-list-activeSelectionBackground` / `-Foreground` | selected nav item, active task row |
| `--wb-focus` | `--vscode-focusBorder` | focus rings, selected sub-tab outline |
| `--wb-tab-active` | `--vscode-panelTitle-activeBorder` / `-activeForeground` | Agent Flow / Agent Work tabs |
| `--wb-input` | `--vscode-input-background` / `--vscode-dropdown-background` | workspace select, Live View dropdown |
| `--wb-chip` | `--vscode-badge-background` / `-foreground` | tag chips, counts |
| `--wb-success` | `--vscode-testing-iconPassed` | checks, In Progress dot, progress bar, `+N` |
| `--wb-danger` | `--vscode-testing-iconFailed` / `--vscode-errorForeground` | High priority, `-N`, failures |
| `--wb-warning` | `--vscode-editorWarning-foreground` | waiting dot |
| `--wb-diff-add` | `--vscode-diffEditor-insertedLineBackground` | added lines |
| `--wb-diff-del` | `--vscode-diffEditor-removedLineBackground` | removed lines |
| `--wb-grid-dot` | `--vscode-editorIndentGuide-background1` | flow canvas dots |

VS Code sets `vscode-dark` / `vscode-light` / `vscode-high-contrast` on `<body>`. Use them only for small tweaks, such as a thicker border in high contrast.

## 3. Agent identity colours

Each agent has one hue. It is used for the avatar, the flow-node border and outgoing edges, and the tinted name chip in the work feed (the hue as text on a ~15% hue background via `color-mix`). The hues map to theme chart and terminal colours, so they adapt to the theme:

| Agent | `agents.color` | Variable | Dark Modern ≈ |
|---|---|---|---|
| Supervisor | supervisor | `--vscode-charts-purple` | #b180d7 |
| Coder | coder | `--vscode-charts-green` | #89d185 |
| Researcher | researcher | `--vscode-charts-blue` | #3794ff |
| Planner | planner | `--vscode-terminal-ansiCyan` | #11a8cd |
| Reviewer | reviewer | `--vscode-charts-yellow` | #cca700 |
| DevOps | devops | `--vscode-charts-orange` | #d18616 |
| Documenter | documenter | `--vscode-terminal-ansiMagenta` | #bc3fbc |
| unknown | — | hash the id into the list above | |

Keep the map in one module (`webview-ui/src/agentColors.ts`). Apply it with `style={{"--agent": \`var(${cssVar})\`}}` and classes that read `var(--agent)`.

Avatars: one round robot glyph SVG tinted with `currentColor` on a hue-tinted circle. The Client (human) gets an initials avatar.

## 4. Status vocabulary → visuals

| Source | Value | Visual |
|---|---|---|
| task.status | active | pill "In Progress" with a success dot; the sidebar label in the accent colour |
| | planning / pending | "Planning" / "Queued", muted |
| | completed | "Done", success text |
| | blocked | "Blocked", warning |
| | cancelled | "Cancelled", muted, struck through |
| priority | 2 / 3 | pill "High" / "Urgent", danger tint + codicon |
| agent state | running / thinking / delegating | success dot (thinking pulses) |
| | waiting | warning dot |
| | idle / completed | muted hollow dot |
| | failed | danger dot |
| plan step | completed | filled success check circle |
| | active | accent ring with an inner dot, accent label |
| | pending | empty muted ring |
| event.status | succeeded | codicon `check`. `running` = `loading~spin`, `failed` = `error`, `pending_approval` = Approve/Reject buttons, `task_completed` = success dot + "Task Completed" |

Every visual carries text or an `aria-label`. Colour is never the only signal.

## 5. Region details

**C. Sidebar (surface `sidebar`)** ← `workspaces.list`, `agents.list`, `tasks.list`, `conversations.list`, and events `agent.state` / `task.updated`.
- A workspace `<select>` (the open workspace folders).
- Nav: Overview, Tasks, Agents, Knowledge (JEV), Memory, Tools, Settings. The selected item has the `--wb-selected` background. A click opens or focuses the matching editor panel (`ui.open*`); Settings runs the existing `agentOrchestrator.openSettings`.
- **AGENTS** (+ = the existing `manageAgents` command): avatar · bold name · description on a second line · state dot on the right.
- **ACTIVE TASKS**: `#12 Fix authentication error` · the status label right-aligned. The row of the open task is selected. A click → `ui.openTask`.
- **RECENT CONVERSATIONS** (+ = new chat): chat codicon · title · relative time on the right.
- Section headers are 11px uppercase, collapsible, and styled like native view headers. Remember the collapsed state in `vscode.setState`.

**E. Task header** ← `tasks.get`. `#12` (muted) + the title (~20px/600) + status pill + priority pill · a description line · tag chips. Right side: Start / Updated / Created by as label: value · the **Complete** button (`tasks.update {status:"completed"}`, disabled when `!canComplete`, with the reason in its tooltip) · a kebab menu (Cancel, Show trace, Copy task ref).

**F. Flow panel.** Tabs: **Agent Flow** · Task Plan · Files · Timeline · Metrics. Right side: a "Live View" dropdown (live / replay), zoom −/+, and fit.
- Agent Flow ← `tasks.flow`. A left-to-right layered DAG on a dotted canvas. Place nodes by the host-provided `layer`; nodes in the same layer stack vertically and are centred. A node is a ~180×56 card: avatar, bold name, a one-line subtitle, the state dot at the top-right, a 1px border in the agent hue (the active node gets a 2px border plus a soft glow). Edges are cubic SVG paths in the **source** hue with arrowheads. Pan and zoom are a CSS transform on one `<g>`. No graph library.
- Task Plan ← `plan.steps`. Timeline ← `tasks.events` as per-agent swimlanes. Metrics ← `tasks.metrics`. Files ← `tasks.files`.

**G. Work panel.** Tabs: **Agent Work** · Chat · Tool Calls · Files · Logs. Right side: a "Group by Agent" switch · an "Auto-scroll" checkbox · a settings gear.
- Agent Work row (~29px): `HH:MM` (muted, tabular numbers) · agent chip · label (single line, ellipsis, full text in a tooltip) · codicon + tool `displayName` (muted) · status icon. Group by Agent = collapsible groups in first-appearance order. Auto-scroll sticks to the bottom only while the user is at the bottom; otherwise show a "Jump to latest" chip. Virtualise the list once there are more than ~500 rows.
- Chat: the task's conversation + a composer → `chat.send`. Tool Calls ← `tasks.toolRuns` (expandable args/summary, a copy-ref button). Logs: raw events in the editor font.

**H. Bottom split** (resizable, ~50/25/25).
- **Code Changes** · Terminal · Test Results · Preview. Code Changes = the path header + a unified diff with line numbers and `--wb-diff-add`/`--wb-diff-del` row backgrounds, in the editor font. The file list comes from `tasks.files`. "Open in diff editor" → `ui.openDiff`. Terminal → `ui.openTerminal`.
- **Test Results** card ← `tasks.tests`: a large "✓ 12 tests passed" + the duration, then case rows (check · name · duration), with overflow as "…".
- **Agent Conversation** ← `conversations.messages`: avatar · author · time, then a message bubble (`--wb-surface`) rendered as Markdown (markdown-it, `html:false`).

**J. Details column.** Tabs: **Task Details** · Agent Details · File Changes.
- Description + Edit (inline textarea → `tasks.update {description}`).
- A property grid: Status, Priority, Type (chip), Created, Updated, Created by.
- **Assignees**: a 2-column grid of cards (avatar, name, activity, state dot).
- **Progress**: a success bar + the % on the right, then the plan checklist.
- **Files Changed (N)**: file codicon · path (click → `ui.openFile`) · `+adds` in success · `-dels` in danger.
- **Related Knowledge (JEV)**: a type codicon (concept `type-hierarchy`, entity `database`, event `zap`, technology `code`) · name · type caption · relation count on the right.

**K. Status bar** ← `health.get` + events. Items: `$(pulse) Agents: 5 running` · `$(tasklist) Tasks: 1 active` · `$(circle-filled) Laya: online` (warning background when offline or in fallback) · `$(database) SQLite: connected`. Each has a tooltip with details and a click command (open overview, open tasks, `testLaya`, show trace). Update on events, not on a timer.

## 6. Typography and density

- Fonts: `var(--vscode-font-family)`, `var(--vscode-font-size)` (13px), and `var(--vscode-editor-font-family)` for diffs, logs, refs and paths.
- Section headers: 11px uppercase with slight tracking. Task title: ~20px/600.
- VS Code density: 22–29px rows, 8–12px padding, 1px borders, flat surfaces, no shadows (except the active flow node's glow).
- Numbers use `font-variant-numeric: tabular-nums`.
