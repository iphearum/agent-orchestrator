// Renders the chat webview (backend/src/vscode/chatWindow.ts) outside VS Code as static HTML pages.
//
//   bun run compile
//   bun .codex/skills/ui-verify/scripts/render-chat.ts --feed conversation --themes light,dark [--agent devops]
//
// Writes .ui-check/chat-<feed>-<theme>.html. A feed is a script that posts the host messages the chat would get
// (session, sessions, user, activity, result, toast …); see feeds/*.js. Open the pages with shoot.ts.
import { plugin } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BODY_CLASS, ERROR_PROBE, parseThemes, THEMES, VSCODE_INJECTED_CSS } from "./themes";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const root = process.cwd();
const out = join(root, ".ui-check");
const compiled = join(root, "dist", "vscode", "chatWindow.js");
if (!existsSync(compiled)) throw new Error("dist/vscode/chatWindow.js is missing. Run `bun run compile` first.");

// The chat host imports `vscode`; a stub is enough to generate its HTML.
plugin({ name: "vscode-stub", setup(build) {
  build.module("vscode", () => ({ loader: "object", exports: {
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: parts.join("/") }) }, ViewColumn: { Active: 1 }, window: {}, env: {},
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    Disposable: { from: () => ({ dispose() {} }) },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }
  } }));
} });
const { ChatWindowProvider } = await import(compiled);

const agent = arg("agent") ?? "devops";
const NAMES: Record<string, string> = { devops: "DevOps", lead: "Lead", coder: "Coder", researcher: "Researcher", planner: "Planner", reviewer: "Reviewer", documenter: "Documenter", database: "Database" };
const agentName = NAMES[agent] ?? agent[0].toUpperCase() + agent.slice(1);
const config = { models: [{ key: "p|m", label: "unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M", model: "unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M" }], selectedModelKey: "p|m", approvalMode: arg("approval") ?? "ask" };
const provider = new ChatWindowProvider({ onDidChange: () => ({ dispose() {} }) }, async () => "", () => config, async () => [], undefined, { fsPath: "" });
provider.selectedAgent = { id: agent, name: agentName };
// markdown-it is loaded from the repo's media folder so answers render as they do in VS Code.
const base: string = provider.html({ cspSource: "", asWebviewUri: (uri: { path?: string }) => `../${uri.path ?? ""}` });

const feedName = arg("feed") ?? "conversation";
const feedPath = existsSync(feedName) ? resolve(feedName) : join(import.meta.dir, "feeds", `${feedName}.js`);
if (!existsSync(feedPath)) throw new Error(`Feed '${feedName}' not found. Use a name from feeds/ or a path to a .js file.`);
// Feeds run inside an IIFE: the chat page already has top-level consts (send, messages, prompt …) a feed must not redeclare.
const feed = `(() => {\n${readFileSync(feedPath, "utf8")}\n})();`;

mkdirSync(out, { recursive: true });
for (const theme of parseThemes(arg("themes"))) {
  const html = base
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace("<head>", `<head>${ERROR_PROBE}<style>:root{${THEMES[theme]}}${VSCODE_INJECTED_CSS}</style><script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){return {}},setState(){}});</script>`)
    .replace("<body>", `<body class="${BODY_CLASS[theme]}">`)
    .replace("</body>", `<script>${feed}</script></body>`);
  const file = join(out, `chat-${basename(feedPath, ".js")}-${theme}.html`);
  writeFileSync(file, html);
  console.log(`wrote ${file}`);
}
