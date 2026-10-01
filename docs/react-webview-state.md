# React webview state and icons

The React UI uses Zustand for runtime query data shared by components within one webview. `useData` stores responses by explicit query key, keeps the last good response visible during refresh, and coalesces overlapping refreshes. Host change events still determine when queries reload.

VS Code creates a separate JavaScript context for each webview, so a Zustand store does not share memory across the sidebar, overview, and task panels. The extension bridge remains the cross-webview source of truth. UI preferences that must survive a webview reload continue to use the bridge's `loadUiState` and `saveUiState` helpers. Temporary component state such as open menus, drafts, and pane interactions stays in React state.

The React webviews use `lucide-react` through the typed `Icon` wrapper in `webview-ui/src/icons.tsx`. Keeping the wrapper preserves existing semantic icon names and tool/entity mappings.

Agent avatars use transparent head images rendered from the procedural Babylon.js robot by one shared offscreen engine per webview: a still when the agent is idle, and a cached looping frame strip (played with CSS steps) for thinking, running, delegating, waiting and failed. No avatar creates its own WebGL context. The chat welcome area renders the default model on one interactive canvas, with reduced-motion support. The separate `wanted` model is opt-in through `AgentRobot3D.mount(canvas, "wanted")` (or `canvas.dataset.robotModel = "wanted"`); its avatar can be requested with `getAvatarSprite("wanted")`. Existing calls with no model argument keep using the default robot. If WebGL cannot initialize, the avatar SVG remains visible and the chat shows its SVG welcome mark.
