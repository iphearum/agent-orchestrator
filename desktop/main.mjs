import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { exec } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AgentDatabase } = require("../dist/database.js");
const { OpenAICompatibleModel } = require("../dist/model.js");
const { Orchestrator } = require("../dist/orchestrator.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);
let window;
let workspaceRoot = app.getPath("documents");
const terminals = new Map();
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
let settings = { baseUrl: "http://localhost:11434/v1", apiKey: "local", model: "qwen3:8b", providers: [], activeProviderId: "", activeModel: "", reasoningEffort: "medium", approvalMode: "approve", layaEnabled: true, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 };
let database;
let model;

async function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsPath(), "utf8")) }; } catch { /* first launch */ }
  settings.approvalMode = ["ask", "approve", "full"].includes(settings.approvalMode) ? settings.approvalMode : "approve";
  if (!Array.isArray(settings.providers) || !settings.providers.length) {
    settings.providers = [{ id: "local", name: "Ollama / OpenAI compatible", protocol: "openai", baseUrl: settings.baseUrl, apiKey: settings.apiKey, models: [settings.model], model: settings.model }];
    settings.activeProviderId = "local";
    settings.activeModel = settings.model;
  }
  settings.activeProviderId ||= settings.providers[0].id;
  const active = settings.providers.find(provider => provider.id === settings.activeProviderId) || settings.providers[0];
  settings.activeProviderId = active.id;
  settings.activeModel ||= active.model || active.models?.[0] || settings.model;
  settings.model = settings.activeModel;
}

function send(channel, payload) { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); }
const getWindowForEvent = event => BrowserWindow.fromWebContents(event.sender);
ipcMain.on("window:minimize", event => getWindowForEvent(event)?.minimize());
ipcMain.on("window:toggle-maximize", event => { const target = getWindowForEvent(event); if (!target) return; target.isMaximized() ? target.unmaximize() : target.maximize(); });
ipcMain.on("window:close", event => getWindowForEvent(event)?.close());

function createWindow() {
  const nativeTitleBar = process.platform !== "darwin";
  window = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1024, minHeight: 680,
    backgroundColor: "#1e1e1e",
    title: "",
    ...(nativeTitleBar ? { titleBarStyle: "hidden", titleBarOverlay: { height: 38 } } : { frame: false }),
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.setMenu(null);
  window.removeMenu();
  window.setMenuBarVisibility(false);
  window.autoHideMenuBar = true;
  const devUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? "http://127.0.0.1:5173" : null);
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(here, "renderer", "dist", "index.html"));
  window.on("closed", () => { window = undefined; });
}

function withinWorkspace(candidate) {
  const resolved = path.resolve(workspaceRoot, candidate || ".");
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) throw new Error("Path is outside the selected workspace.");
  return resolved;
}

async function safeWorkspacePath(candidate, allowNew = false) {
  const resolved = withinWorkspace(candidate);
  const realRoot = await fs.realpath(workspaceRoot);
  let checked = resolved;
  if (allowNew) {
    try { checked = await fs.realpath(resolved); }
    catch {
      let parent = path.dirname(resolved);
      const missing = [path.basename(resolved)];
      while (parent !== path.dirname(parent)) {
        try { checked = path.join(await fs.realpath(parent), ...missing); break; }
        catch { missing.unshift(path.basename(parent)); parent = path.dirname(parent); }
      }
    }
  } else checked = await fs.realpath(resolved);
  if (checked !== realRoot && !checked.startsWith(realRoot + path.sep)) throw new Error("Workspace symlinks cannot access files outside the selected folder.");
  return resolved;
}

const searchableExtensions = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".html", ".java", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".rs", ".scss", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"]);
const searchSkipDirectories = new Set([".git", ".next", ".venv", "coverage", "dist", "node_modules", "out", "release", "vendor"]);

async function searchWorkspace(query, options = {}) {
  const stopWords = new Set(["about", "after", "also", "and", "are", "can", "find", "for", "from", "help", "into", "that", "the", "this", "with", "you"]);
  const caseSensitive = Boolean(options.caseSensitive);
  const wholeWord = Boolean(options.wholeWord);
  const rawTerms = String(query || "").match(/[a-z0-9_./-]{2,}/gi) || [];
  const terms = [...new Set(rawTerms.map(term => caseSensitive ? term : term.toLowerCase()))].filter(term => !stopWords.has(term.toLowerCase())).slice(0, 8);
  if (!terms.length) return { terms: [], results: [] };
  const matchers = wholeWord ? terms.map(term => new RegExp(`(^|[^A-Za-z0-9_])${term.replace(/\./g, "\\.")}(?=$|[^A-Za-z0-9_])`, caseSensitive ? "" : "i")) : [];

  const candidates = [];
  const walk = async (directory, depth = 0) => {
    if (depth > 9 || candidates.length >= 1200) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (candidates.length >= 1200) break;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (searchSkipDirectories.has(entry.name)) continue;
        await walk(target, depth + 1);
      } else if (entry.isFile() && searchableExtensions.has(path.extname(entry.name).toLowerCase())) {
        candidates.push(target);
      }
    }
  };
  await walk(workspaceRoot);

  const matches = [];
  let scannedBytes = 0;
  for (const filePath of candidates) {
    let text;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 256 * 1024 || scannedBytes + stat.size > 64 * 1024 * 1024) continue;
      scannedBytes += stat.size;
      text = await fs.readFile(filePath, "utf8");
      if (text.includes("\u0000")) continue;
    } catch { continue; }
    const relativePath = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const lower = caseSensitive ? line : line.toLowerCase();
      const found = terms.filter((term, termIndex) => wholeWord ? matchers[termIndex].test(line) : lower.includes(term));
      if (!found.length) continue;
      matches.push({ path: relativePath, line: index + 1, snippet: line.trim().slice(0, 240), score: found.length });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return { terms, totalMatches: matches.length, fileCount: new Set(matches.map(match => match.path)).size, results: matches.slice(0, 50).map(({ score, ...result }) => result) };
}

function validateChatImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images) || images.length > 6) throw new Error("Attach up to 6 images per conversation.");
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  let totalBytes = 0;
  return images.map(image => {
    const dataUrl = String(image?.dataUrl || "");
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || !allowed.has(match[1]) || image.mimeType !== match[1]) throw new Error("Use PNG, JPEG, WebP, or GIF images.");
    const bytes = Math.floor(match[2].length * 3 / 4);
    if (bytes > 6 * 1024 * 1024) throw new Error("Each image must be 6 MB or smaller.");
    totalBytes += bytes;
    if (totalBytes > 18 * 1024 * 1024) throw new Error("The attached images exceed the 18 MB conversation limit.");
    return { name: path.basename(String(image.name || "image")).slice(0, 120), mimeType: match[1], dataUrl };
  });
}

function publicEntry(root, item) {
  return { name: item.name, path: path.relative(root, path.join(root, item.name)).split(path.sep).join("/"), directory: item.isDirectory() };
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await loadSettings();
  await fs.mkdir(path.join(app.getPath("userData"), "agent-data"), { recursive: true });
  database = new AgentDatabase(path.join(app.getPath("userData"), "agent-data"));
  database.seedAgents();
  model = new OpenAICompatibleModel(() => settings);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

ipcMain.handle("workspace:open", async () => {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { root: workspaceRoot };
  workspaceRoot = result.filePaths[0];
  for (const [id, terminal] of terminals) startTerminal(id, { cols: terminal.cols, rows: terminal.rows });
  return { root: workspaceRoot, entries: await listFiles(".") };
});
ipcMain.handle("workspace:current", async () => ({ root: workspaceRoot, entries: await listFiles(".") }));
ipcMain.handle("workspace:list", async (_event, relativePath) => listFiles(relativePath));
ipcMain.handle("workspace:search", async (_event, query, options) => searchWorkspace(query, options));
ipcMain.handle("workspace:read", async (_event, relativePath) => fs.readFile(await safeWorkspacePath(relativePath), "utf8"));
ipcMain.handle("workspace:read-image", async (_event, relativePath) => {
  const target = await safeWorkspacePath(relativePath);
  const extension = path.extname(target).toLowerCase();
  const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" })[extension];
  if (!mimeType) throw new Error("This image format is not supported.");
  const image = await fs.readFile(target);
  if (image.length > 12 * 1024 * 1024) throw new Error("Workspace images must be 12 MB or smaller to preview.");
  return `data:${mimeType};base64,${image.toString("base64")}`;
});
ipcMain.handle("workspace:write", async (_event, relativePath, content) => {
  const target = await safeWorkspacePath(relativePath, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return true;
});
async function listFiles(relativePath) {
  const root = await safeWorkspacePath(relativePath);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter(item => ![".git", "node_modules", "dist", ".codex"].includes(item.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(item => ({ ...publicEntry(root, item), path: path.join(relativePath || ".", item.name).split(path.sep).join("/") }));
}

ipcMain.handle("agents:list", () => database.listAgents());
ipcMain.handle("agents:save", (_event, agent) => { database.upsertAgent(agent); return database.listAgents(); });
ipcMain.handle("agents:delete", (_event, agentId) => { database.deleteAgent(agentId); return database.listAgents(); });
ipcMain.handle("settings:get", () => ({ ...settings }));
ipcMain.handle("settings:save", async (_event, next) => {
  settings = { ...settings, ...next, approvalMode: settings.approvalMode };
  if (Array.isArray(next.providers)) settings.providers = next.providers.filter(provider => provider && provider.id && provider.name && provider.baseUrl).map(provider => ({
    id: String(provider.id), name: String(provider.name), protocol: provider.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(provider.baseUrl).replace(/\/$/, ""), apiKey: String(provider.apiKey || ""),
    models: Array.isArray(provider.models) ? [...new Set(provider.models.map(model => String(model).trim()).filter(Boolean))] : [],
    model: String(provider.model || provider.models?.[0] || "")
  }));
  if (Array.isArray(settings.providers) && settings.providers.length) {
    let active = settings.providers.find(provider => provider.id === settings.activeProviderId) || settings.providers[0];
    if (next.activeModel && active.models?.length && !active.models.includes(next.activeModel)) next.activeModel = active.models.includes(active.model) ? active.model : active.models[0];
    settings.activeProviderId = active.id;
    settings.activeModel = String(next.activeModel || (active.models?.includes(active.model) ? active.model : active.models?.[0]) || active.model || "");
    active.model = settings.activeModel;
    settings.model = settings.activeModel;
    settings.baseUrl = active.baseUrl;
    settings.apiKey = active.apiKey;
  }
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
});
ipcMain.handle("settings:approval-mode", async (_event, requestedMode) => {
  const mode = ["ask", "approve", "full"].includes(requestedMode) ? requestedMode : "approve";
  if (mode === "full" && settings.approvalMode !== "full") {
    const response = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Enable Full access?",
      message: "Agents will be able to run shell commands as your Windows user.",
      detail: "Commands can read or change files anywhere on this computer and connect to the internet. Only enable this for work you trust.",
      buttons: ["Cancel", "Enable Full access"],
      defaultId: 0,
      cancelId: 0
    });
    if (response.response !== 1) return { approvalMode: settings.approvalMode, accepted: false };
  }
  settings.approvalMode = mode;
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  return { approvalMode: settings.approvalMode, accepted: true };
});
ipcMain.handle("conversations:list", () => database.listConversations());
ipcMain.handle("conversations:get", (_event, id) => database.conversationMessages(String(id || "")));
async function requestToolApproval({ agentName, toolName, argumentsJson }) {
  if (!window || window.isDestroyed()) return false;
  let args = {};
  try { args = JSON.parse(argumentsJson || "{}"); } catch { /* show a generic action description */ }
  const actions = {
    ask_agent: ["consult another agent", args.question],
    delegate_task: ["delegate a task", args.instruction],
    remember: [args.scope === "project" ? "save a shared project note" : "save a private agent note", args.content],
    remember_entity: ["update saved project context", args.name]
  };
  const [action, detail] = actions[toolName] || ["perform an agent action", ""];
  const response = await dialog.showMessageBox(window, {
    type: "question",
    title: "Approve agent action",
    message: `${agentName} wants to ${action}.`,
    detail: String(detail || "").trim().slice(0, 500),
    buttons: ["Deny", "Approve once"],
    defaultId: 0,
    cancelId: 0
  });
  return response.response === 1;
}
async function runFullAccessCommand(command) {
  const source = String(command || "").trim();
  if (!source) return JSON.stringify({ error: "Command cannot be empty." });
  if (source.length > 12000) return JSON.stringify({ error: "Command is too long (12,000 character limit)." });
  const clip = value => String(value || "").slice(0, 50000);
  try {
    const { stdout, stderr } = await execAsync(source, { cwd: workspaceRoot, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.stringify({ exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) });
  } catch (error) {
    return JSON.stringify({ exitCode: error.code ?? null, signal: error.signal ?? null, timedOut: Boolean(error.killed), stdout: clip(error.stdout), stderr: clip(error.stderr || error.message) });
  }
}
ipcMain.handle("chat:run", async (_event, request) => {
  const orchestrator = new Orchestrator(database, model, event => send("agent:event", event), undefined, settings, requestToolApproval, runFullAccessCommand);
  const images = validateChatImages(request.images);
  try {
    return await orchestrator.runRoot(request.prompt, request.agentId || "lead", false, {
      conversationId: request.conversationId,
      images,
      attachedImageNames: Array.isArray(request.newImageNames) ? request.newImageNames.slice(0, 6).map(name => String(name).slice(0, 120)) : [],
      thinking: Boolean(request.thinking),
      reasoningEffort: ["low", "medium", "high"].includes(request.reasoningEffort) ? request.reasoningEffort : "medium",
      planMode: Boolean(request.planMode),
      approvalMode: ["ask", "approve", "full"].includes(request.approvalMode) ? request.approvalMode : settings.approvalMode,
      title: String(request.title || request.prompt || "New conversation"),
      displayPrompt: String(request.displayPrompt || request.prompt || "")
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error?.cause instanceof Error ? error.cause.message : "";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(`${message} ${cause}`)) {
      throw new Error("Can't reach the configured model provider. Start the model service, then check the URL and API key in Settings → Model provider.");
    }
    throw error;
  }
});

function startTerminal(id = "terminal-1", dimensions = {}) {
  terminals.get(id)?.kill();
  const shell = process.platform === "win32" ? (process.env.COMSPEC || "powershell.exe") : (process.env.SHELL || "/bin/bash");
  const terminal = spawnPty(shell, process.platform === "win32" ? [] : ["-l"], {
    name: "xterm-256color", cols: dimensions.cols || 100, rows: dimensions.rows || 28,
    cwd: workspaceRoot, env: { ...process.env, TERM: "xterm-256color" }
  });
  terminals.set(id, terminal);
  terminal.onData(data => { if (terminals.get(id) === terminal) send("terminal:data", { id, data }); });
  terminal.onExit(exit => { if (terminals.get(id) === terminal) { terminals.delete(id); send("terminal:exit", { id, ...exit }); } });
  return terminal;
}
ipcMain.handle("terminal:start", (_event, { id, ...dimensions } = {}) => { startTerminal(id, dimensions); return true; });
ipcMain.on("terminal:input", (_event, { id, data }) => terminals.get(id)?.write(data));
ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => { const terminal = terminals.get(id); if (terminal && cols > 0 && rows > 0) terminal.resize(cols, rows); });
ipcMain.handle("terminal:close", (_event, id) => { terminals.get(id)?.kill(); terminals.delete(id); return true; });

app.on("window-all-closed", () => { for (const terminal of terminals.values()) terminal.kill(); terminals.clear(); if (process.platform !== "darwin") app.quit(); });
