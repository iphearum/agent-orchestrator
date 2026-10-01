// Runs one real orchestrator task against an OpenAI-compatible endpoint, outside VS Code,
// then prints what the task panel would show. Uses a temp database and a temp copy of test-workspace/.
//
//   AO_BASE_URL=https://host/v1 AO_API_KEY=... AO_MODEL=... bun scripts/smoke-orchestrator.ts "your prompt" [agent-id]
//
// The default agent is "lead", which plans and delegates but cannot read or write files itself;
// pass "coder" to hand the task straight to the agent that can.
//
// Without AO_* variables it reads test-workspace/.vscode/settings.json.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AgentDatabase } from "../backend/src/persistence/database";
import { OpenAICompatibleModel } from "../backend/src/core/model";
import { Orchestrator } from "../backend/src/core/orchestrator";
import { AgentDecisionEngine } from "../backend/src/core/decision";
import { RuntimeActivity } from "../backend/src/core/activity";
import { WorkbenchViews } from "../backend/src/vscode/webviews/views";
import { formatSearch, outline, readWindow } from "../backend/src/tools/fileView";

const root = resolve(import.meta.dir, "..");
const settingsFile = join(root, "test-workspace", ".vscode", "settings.json");
const settings: Record<string, string> = existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, "utf8").replace(/^\s*\/\/.*$/gm, ""))
  : {};
const baseUrl = process.env.AO_BASE_URL ?? settings["agentOrchestrator.baseUrl"];
const apiKey = process.env.AO_API_KEY ?? settings["agentOrchestrator.apiKey"] ?? "local";
const modelName = process.env.AO_MODEL ?? settings["agentOrchestrator.model"];
if (!baseUrl || !modelName) throw new Error("Set AO_BASE_URL and AO_MODEL, or fill test-workspace/.vscode/settings.json.");

const agentId = process.argv[3] ?? "lead";
const prompt = process.argv[2] ?? "POST /api/auth/login returns 500 for unknown emails. Read src/auth/login.py, find the cause, and fix it with write_file.";

const work = mkdtempSync(join(tmpdir(), "ao-smoke-"));
const workspace = join(work, "workspace");
// AO_WORKSPACE picks another folder to copy (relative to the repo), e.g. backend/src for a larger codebase.
cpSync(join(root, process.env.AO_WORKSPACE ?? "test-workspace"), workspace, { recursive: true, filter: source => !source.includes(`${sep}.vscode`) });

/** Minimal workspace tools over the temp copy; paths cannot leave it. */
const inside = (path: string) => {
  const target = resolve(workspace, path);
  if (!target.startsWith(workspace + sep)) throw new Error("Path is outside the workspace.");
  return target;
};
const listFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
const workspaceTools = {
  async execute(name: string, args: Record<string, unknown>) {
    try {
      if (name === "read_file") return readWindow(String(args.path), readFileSync(inside(String(args.path)), "utf8"), Number(args.start_line) || undefined, Number(args.end_line) || undefined);
      if (name === "file_outline") return outline(String(args.path), readFileSync(inside(String(args.path)), "utf8"));
      if (name === "write_file") {
        const target = inside(String(args.path));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(args.content ?? ""));
        return JSON.stringify({ ok: true, path: args.path });
      }
      if (name === "search_workspace") {
        const query = String(args.query ?? "").toLowerCase();
        const files = listFiles(workspace);
        const hits = files.flatMap(file => readFileSync(file, "utf8").split(/\r?\n/).map((text, i) => ({ path: relative(workspace, file).split(sep).join("/"), line: i + 1, text })).filter(hit => hit.text.toLowerCase().includes(query)));
        return formatSearch(String(args.query ?? ""), hits.slice(0, 60), files.length, hits.length > 60);
      }
      return JSON.stringify({ error: `Unknown workspace tool '${name}'.` });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
};

const db = new AgentDatabase(join(work, "db"));
db.seedAgents();
const activity = new RuntimeActivity();
const model = new OpenAICompatibleModel(() => ({ baseUrl, apiKey, model: modelName }));
const orchestrator = new Orchestrator(
  db, model,
  event => {
    activity.handle(event);
    if (event.type !== "chunk" && event.type !== "stream_reset") console.log(`  [${event.type}] ${event.agentId}: ${event.text.replace(/\s+/g, " ").slice(0, 140)}`);
  },
  new AgentDecisionEngine(undefined, undefined, "none"),
  { layaEnabled: false, maxDelegationDepth: 2, maxDelegationsPerTask: 4, contextRecentMessages: 6 },
  async () => true,
  undefined, undefined, undefined, undefined,
  workspaceTools
);

console.log(`Model: ${modelName} @ ${baseUrl}\nAgent: ${agentId}\nPrompt: ${prompt}\n`);
const started = Date.now();
let failure: unknown;
try {
  const result = await orchestrator.runRoot(prompt, agentId, false, { approvalMode: "approve" });
  console.log(`\nResult (${((Date.now() - started) / 1000).toFixed(1)}s):\n${result.slice(0, 1200)}\n`);
} catch (error) {
  failure = error;
  console.log(`\nRun failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}\n`);
}

const views = new WorkbenchViews(db, activity, { layaEnabled: () => false, layaEndpoint: () => "", layaStatus: () => ({ connected: false }), workspaces: () => [{ key: workspace, name: "test-workspace" }] });
const taskId = views.latestTaskId();
const bundle = taskId ? views.task(taskId) : undefined;
if (bundle) {
  console.log(`Task panel: #${bundle.task.number} "${bundle.task.title}" — ${bundle.task.status}`);
  console.log(`Flow: ${bundle.flow.nodes.map(node => node.title).join(" → ")}`);
  console.log("Agent Work:");
  for (const event of bundle.events) console.log(`  ${event.agent?.name ?? "system"} · ${event.label}${event.tool ? ` [${event.tool.displayName}]` : ""} (${event.status})`);
  console.log(`Files changed: ${bundle.files.map(file => `${file.path} +${file.additions}`).join(", ") || "none"}`);
}
const fixed = join(workspace, "src", "auth", "login.py");
if (existsSync(fixed)) console.log(`\nlogin.py after the run:\n${readFileSync(fixed, "utf8")}`);
console.log(`Temp files: ${work}`);
db.connection.close();
if (failure) process.exitCode = 1;
