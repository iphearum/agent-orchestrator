# React webview state and icons

The React UI uses Zustand for runtime query data shared by components within one webview. `useData` stores responses by explicit query key, keeps the last good response visible during refresh, and coalesces overlapping refreshes. Host change events still determine when queries reload.

VS Code creates a separate JavaScript context for each webview, so a Zustand store does not share memory across the sidebar, overview, and task panels. The extension bridge remains the cross-webview source of truth. UI preferences that must survive a webview reload continue to use the bridge's `loadUiState` and `saveUiState` helpers. Temporary component state such as open menus, drafts, and pane interactions stays in React state.

The React webviews use `lucide-react` through the typed `Icon` wrapper in `webview-ui/src/icons.tsx`. Keeping the wrapper preserves existing semantic icon names and tool/entity mappings. The project robot avatar remains a custom SVG to preserve its distinct face and agent tint.
