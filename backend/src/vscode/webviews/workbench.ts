import * as vscode from "vscode";
import type { AgentDatabase } from "../../persistence/database";
import type { RuntimeActivity } from "../../core/activity";
import type { MethodName, Methods, NavTarget } from "../../shared/protocol";
import { OrchestratorStatusBar } from "../statusBar";
import { SidebarViewProvider, SIDEBAR_VIEW_ID } from "./sidebarView";
import { TaskPanels, TASK_PANEL_VIEW_TYPE } from "./taskPanels";
import { OverviewPanel, OVERVIEW_VIEW_TYPE } from "./overviewPanel";
import { RpcError, type ChangeScope } from "./webviewHost";
import { WorkbenchViews, type HostInfo } from "./views";

const NAV_TARGETS: NavTarget[] = ["overview", "tasks", "agents", "knowledge", "memory", "tools", "settings"];
const UI_COMMANDS = {
  newTask: "agentOrchestrator.runTask",
  manageAgents: "agentOrchestrator.manageAgents",
  testLaya: "agentOrchestrator.testLaya"
} as const;

const str = (params: unknown, key: string, max = 20_000): string => {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "string" || !value || value.length > max) throw new RpcError("bad_params", `Missing or invalid "${key}".`);
  return value;
};

/** Composes the orchestration UI: sidebar, task panels, status bar, and the RPC they share. */
export class Workbench implements vscode.Disposable {
  readonly views: WorkbenchViews;
  private readonly sidebar: SidebarViewProvider;
  private readonly panels: TaskPanels;
  private readonly overview: OverviewPanel;
  private readonly statusBar = new OrchestratorStatusBar();
  private readonly disposables: vscode.Disposable[] = [];
  private terminal?: vscode.Terminal;
  private statusTimer?: ReturnType<typeof setTimeout>;

  constructor(
    context: vscode.ExtensionContext,
    db: AgentDatabase,
    activity: RuntimeActivity,
    host: HostInfo,
    private readonly chatWithAgent: (agentId: string) => void,
    private readonly openChatSession: (conversationId: string) => void
  ) {
    this.views = new WorkbenchViews(db, activity, host);
    const router = (method: MethodName, params: unknown) => this.route(method, params);
    this.sidebar = new SidebarViewProvider(context.extensionUri, router);
    this.panels = new TaskPanels(context.extensionUri, router, taskId => {
      const task = this.views.repo.getRootTask(taskId);
      return task ? `Task #${task.number}` : undefined;
    });
    this.overview = new OverviewPanel(context.extensionUri, router);
    this.disposables.push(
      this.sidebar, this.panels, this.overview, this.statusBar,
      vscode.window.registerWebviewPanelSerializer(OVERVIEW_VIEW_TYPE, this.overview),
      vscode.commands.registerCommand("agentOrchestrator.openMonitor", () => this.overview.show()),
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, this.sidebar),
      vscode.window.registerWebviewPanelSerializer(TASK_PANEL_VIEW_TYPE, this.panels),
      activity.onDidChange(change => this.notify(["agents", "tasks", "health", "conversations"], change.rootTaskId ? [change.rootTaskId] : undefined)),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("agentOrchestrator")) this.notify(["health"]); }),
      vscode.window.onDidCloseTerminal(closed => { if (closed === this.terminal) this.terminal = undefined; }),
      vscode.commands.registerCommand("agentOrchestrator.openLatestTask", () => {
        const taskId = this.views.latestTaskId();
        if (taskId) this.panels.open(taskId);
        else void vscode.window.showInformationMessage("No agent tasks yet. Start one from the chat or with “Agent Orchestrator: Run Task”.");
      }),
      vscode.commands.registerCommand("agentOrchestrator.openTask", (taskId?: string) => { if (typeof taskId === "string") this.panels.open(taskId); })
    );
    this.refreshStatusBar();
  }

  /** Tell every open view that runtime data changed. Pass taskIds to limit which task panels refetch. */
  notify(scopes: ChangeScope[], taskIds?: string[]) {
    this.sidebar.notify(scopes, taskIds);
    this.panels.notify(scopes, taskIds);
    this.overview.notify(scopes);
    if (!this.statusTimer) this.statusTimer = setTimeout(() => this.refreshStatusBar(), 250);
  }

  dispose() {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private refreshStatusBar() {
    this.statusTimer = undefined;
    this.statusBar.update(this.views.health());
  }

  private async route(method: MethodName, params: unknown): Promise<Methods[MethodName]["result"]> {
    switch (method) {
      case "sidebar.get": return this.views.sidebar();
      case "overview.get": return this.views.overview();
      case "task.get": {
        const bundle = this.views.task(str(params, "taskId", 200));
        if (!bundle) throw new RpcError("not_found", "This task no longer exists.");
        return bundle;
      }
      case "task.latest": return { taskId: this.views.latestTaskId() };
      case "task.update": {
        const taskId = str(params, "taskId", 200);
        const p = params as { description?: unknown; status?: unknown };
        if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > 20_000)) throw new RpcError("bad_params", "Invalid description.");
        if (p.status !== undefined && p.status !== "completed" && p.status !== "cancelled") throw new RpcError("bad_params", "Invalid status.");
        try {
          const task = this.views.updateTask(taskId, { description: p.description as string | undefined, status: p.status as "completed" | "cancelled" | undefined });
          this.notify(["tasks"], [taskId]);
          return task;
        } catch (error) {
          throw new RpcError("invalid_transition", error instanceof Error ? error.message : String(error));
        }
      }
      case "ui.openTask":
        this.panels.open(str(params, "taskId", 200));
        return null;
      case "ui.openConversation": {
        // Conversations are chat sessions: reopen them in the chat so they can be continued.
        this.openChatSession(str(params, "conversationId", 200));
        return null;
      }
      case "ui.openFile": {
        const uri = this.workspaceFile(str(params, "path", 1000));
        await vscode.window.showTextDocument(uri, { preview: true });
        return null;
      }
      case "ui.openTerminal": {
        this.terminal ??= vscode.window.createTerminal({ name: "Agent Orchestrator", cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
        this.terminal.show();
        return null;
      }
      case "ui.chatWithAgent":
        this.chatWithAgent(str(params, "agentId", 200));
        return null;
      case "ui.command": {
        const command = str(params, "command", 40);
        if (command === "newChat") this.chatWithAgent("team");
        else if (command in UI_COMMANDS) await vscode.commands.executeCommand(UI_COMMANDS[command as keyof typeof UI_COMMANDS]);
        else throw new RpcError("bad_params", "Unknown command.");
        return null;
      }
      case "ui.navigate": {
        const target = str(params, "target", 20) as NavTarget;
        if (!NAV_TARGETS.includes(target)) throw new RpcError("bad_params", "Unknown view.");
        await this.navigate(target);
        return null;
      }
      case "ui.showToolRun": {
        const run = this.views.repo.toolRun(str(params, "toolRunId", 200));
        if (!run) throw new RpcError("not_found", "Tool run not found.");
        const parse = (text: string | null) => { try { return JSON.parse(text ?? "null"); } catch { return text; } };
        const content = JSON.stringify({ tool: run.tool_name, status: run.status, agent: run.agent_id, at: run.created_at, arguments: parse(run.arguments_json), result: parse(run.result_json) }, null, 2);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "json", content }), { preview: true });
        return null;
      }
      default:
        throw new RpcError("unknown_method", `Unknown method ${String(method)}.`);
    }
  }

  private async navigate(target: NavTarget) {
    switch (target) {
      case "overview": this.overview.show(); break;
      case "agents": await vscode.commands.executeCommand("agentOrchestrator.manageAgents"); break;
      case "settings": await vscode.commands.executeCommand("agentOrchestrator.openSettings"); break;
      case "tasks": {
        const tasks = this.views.repo.listRootTasks(50);
        if (!tasks.length) { void vscode.window.showInformationMessage("No agent tasks yet."); return; }
        const pick = await vscode.window.showQuickPick(tasks.map(task => ({ label: `#${task.number} ${task.title.split(/\r?\n/)[0].slice(0, 90)}`, description: task.status, id: task.id })), { title: "Open task" });
        if (pick) this.panels.open(pick.id);
        break;
      }
      default:
        void vscode.window.showInformationMessage(`The ${target === "knowledge" ? "Knowledge (JEV)" : target === "memory" ? "Memory" : "Tools"} view is not built yet.`);
    }
  }

  /** Resolve a workspace-relative path from the webview, refusing anything outside the first folder. */
  private workspaceFile(relativePath: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new RpcError("no_workspace", "Open a workspace folder first.");
    if (/^([a-z]:|[\\/])/i.test(relativePath)) throw new RpcError("bad_params", "Only workspace-relative paths can be opened.");
    const segments = relativePath.split(/[\\/]+/).filter(segment => segment && segment !== ".");
    if (!segments.length || segments.includes("..")) throw new RpcError("bad_params", "The path is outside the workspace.");
    return vscode.Uri.joinPath(folder.uri, ...segments);
  }
}
