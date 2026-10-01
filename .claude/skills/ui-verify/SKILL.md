---
name: ui-verify
description: Verify the extension's UI visually before calling a UI change done — render the chat window (backend/src/vscode/chatWindow.ts) and the React webviews (webview-ui: task panel, sidebar, overview) outside VS Code, screenshot them with headless Chrome in light, dark and high-contrast themes and at narrow widths, check for script errors, and look at the result. Use this after ANY change to webview-ui/, chatWindow.ts, media/*.html|css|js, styles, themes, layout, responsive behaviour or icons, whenever the user reports a UI bug or sends a UI screenshot, or asks to "check", "verify", "screenshot" or "compare with the design".
---

# UI verification

A UI change is verified when you have **looked at a screenshot** of it, in more than one theme and width, with no script errors. It is not verified by a clean build. Every bug the user has reported in these views so far was visible in a screenshot and invisible to `tsc`:
- stray empty bubbles;
- toolbars covering text;
- controls wrapping onto a second row;
- scrollbar arrows;
- hidden buttons that still showed.

Scripts live in `.claude/skills/ui-verify/scripts/` and write to `.ui-check/`, which is gitignored. Run them from the repo root with `bun`.

## Chat window (vanilla HTML in `chatWindow.ts`)

```bash
bun run compile                                                     # render-chat reads dist/vscode/chatWindow.js
S=.claude/skills/ui-verify/scripts
bun $S/render-chat.ts --feed conversation --themes light,dark,hc   # → .ui-check/chat-conversation-<theme>.html
bun $S/shoot.ts .ui-check/chat-conversation-light.html --dump       # script errors + debug summary; exit 1 on errors
bun $S/shoot.ts .ui-check/chat-conversation-light.html              # → .ui-check/chat-conversation-light.png
bun $S/shoot.ts .ui-check/chat-conversation-dark.html --hash hover  # force hover-only toolbars visible
bun $S/shoot.ts .ui-check/chat-conversation-light.html --widths 420,340,280 --size 400x560
```

`render-chat.ts` builds the real page from the compiled provider with a stubbed `vscode` module. It injects theme variables and VS Code's own scrollbar CSS, and adds an error probe. Options: `--agent devops|lead|coder…` and `--approval ask|approve|full`.

**Feeds** (`scripts/feeds/*.js`) post the host messages the page would receive. Pick the one that exercises your change, or write a new one:

| Feed | Shows | Self-check (`--dump` prints `debug:`) |
|---|---|---|
| `conversation` | history rail + an opened chat with code, inline code and a quote; `#hover` shows message toolbars | — |
| `live` | a replayed run: user message, agent start, three repeated reads, result, toast | `messages=2 working=0 collapsed=×3` |
| `empty` | a new chat with no history: home header only | `home=true back=false more=false recents=false` |
| `home` | home screen with 7 chats: top 5 recents, short ages, View all; `--hash history` opens the history page | `recentRows=5 viewAll=View all (7) historyOpen=false` |
| `working` | a reply mid-run: pasted image above the bubble, "Working for Ns", open step list with icons, edited-files card | `pending=1 visibleSteps=6 head=Working for Ns · waiting for Coder files=1 images=1` |
| `finished` | a finished reply: "Worked for Ns ›" folds the steps; `--hash open` expands them | `head=Worked for Ns stepsVisible=false summary=Read files, searched the workspace, edited files, ran commands files=2` |
| `history` | a reopened chat: an old answer without a record, a saved reply with steps/thinking/file, a failed reply; `--hash open` expands the saved steps | `replies=3 heads=Worked for 1m 05s|Stopped after 4s pending=0 files=1 failed=1 handoffs=Asked Researcher answers=1` |
| `streaming` | a reply mid-stream, cut inside an unclosed ```json fence: Markdown must already be rendered | `h2=1 h3=2 li=2 strong=1 pre=1 rawMarks=false` |
| `laya-paused` | Laya paused: the status line under the header with Resume; `--hash resumed` hides it again | `shown=true text=Laya paused since HH:MM · routing uses the fallback` |
| `delegation` | Lead delegates to Planner, who asks Researcher: nested hand-off groups mid-run; `--hash done` shows answers | `groups=2 nested=1 labels=Delegating to Planner|Asking Researcher head=Working for Ns · waiting for Researcher answers=0 loose=1 bubbles=0` |
| `model-effort` | the model + effort popup, slider at Medium; `--hash models` shows the model list | `pill=qwen3.5:0.8bMedium effort=Medium menu=true effortView=true modelView=false` |

A feed runs inside an IIFE, because the chat page already declares top-level `const`s (`send`, `messages`, `prompt`, `queue`…). Host messages are delivered asynchronously, so read the DOM in a `setTimeout` after posting, not straight away. Put conclusions in `document.documentElement.dataset.debug` so `--dump` prints them. Message types are listed in `ChatWindowMessage` and in the `post({ type: … })` calls in `chatWindow.ts`, e.g. `session`, `sessions`, `session-meta`, `user`, `activity`, `chunk`, `result`, `error`, `toast`, `queue`.

## React webviews (`webview-ui/`: task panel, sidebar, overview)

These render from design fixtures (`webview-ui/src/fixtures.ts`) through Bun's dev server. Start it in the background and wait for "ready":

```bash
bun --port=5174 webview-ui/dev.html            # run_in_background; the flag must come before the file
S=.claude/skills/ui-verify/scripts
bun $S/shoot.ts "http://localhost:5174/?theme=light" --out task-light --size 1250x900
bun $S/shoot.ts "http://localhost:5174/" --out task-dark --size 1250x900                # default fallbacks are Dark Modern
bun $S/shoot.ts "http://localhost:5174/?task=t1&theme=light" --out task-simple --widths 535,930 --size 900x900
bun $S/shoot.ts "http://localhost:5174/?surface=sidebar&theme=light" --out sidebar --size 300x960
bun $S/shoot.ts "http://localhost:5174/?surface=overview&theme=light" --out overview --size 1150x900
bun $S/shoot.ts "http://localhost:5174/?theme=light" --dump
```

`?task=t1` is a one-agent, finished task, which is what small real runs look like. The default is the design's multi-agent #12. Stop the server with `TaskStop` when done. If a surface needs new data, add it to `fixtures.ts` rather than faking it in the component.

## Look, then compare

Open every PNG with the **Read** tool. Check it against the list below and, for the task panel, against `target/real_ui_design.png`:
- **Theme integration:** surfaces, borders and text follow the theme in light, dark and hc. Look for text that vanishes in one theme (light hues on light backgrounds, same-colour buttons on inputs), and for hard-coded white or black.
- **Stray or missing elements:** empty bubbles or labels, things marked `hidden` that still show (`[hidden]` loses to `display: grid/flex` unless overridden), leftover "working" rows.
- **Overlap and wrapping:** toolbars covering text, labels breaking onto several lines, controls wrapping onto a second row, ellipsis where the full text should fit.
- **Width:** at 280–420 px, one-row composers, no horizontal page scroll, drawers instead of rails.
- **Scrollbars:** thin sliders with no arrow buttons. VS Code's injected `scrollbar-color` brings arrows back unless `html, body { scrollbar-color: auto !important }` is set.
- **Hover and focus states:** use `#hover` or a feed to force them; headless Chrome never hovers.

Tell the user what you checked and what you found, and include the fixes. If something can only be checked inside VS Code (real theme variables, native dialogs, drag handles), say so rather than implying it was verified.

## Pitfalls (all hit in this repo)

- `bun` here is the **Windows** binary run through WSL. It can't write to WSL's `/tmp`, so keep outputs in `.ui-check/`. It also only sees environment variables listed in `WSLENV`, e.g. `CHROME=… WSLENV=CHROME`.
- **Headless Chrome won't size a window below about 500 px.** Screenshots at 420 or 280 then look identical and clipped, so use `--widths`, which shoots inside fixed-width iframes.
- **Errors in scripts loaded from separate `file://` files are masked** as "Script error." `render-chat.ts` inlines everything so `--dump` shows the real message.
- **Allow for animations:** the chat's menus and toolbars fade in and can be captured mid-transition. Force the state with a feed (`transition = "none"`) rather than trusting a faint screenshot.
- **Theme variables are approximations** of Light Modern, Dark Modern and High Contrast (`scripts/themes.ts`). Final colour checks belong in VS Code: F5 → switch themes.

## Clean up

Delete `.ui-check/` when you're done (`rm -rf .ui-check`), and stop any dev server you started.
