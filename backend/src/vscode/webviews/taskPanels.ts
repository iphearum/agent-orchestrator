import * as vscode from "vscode";
import { renderHtml, webviewOptions, WebviewConnection, type ChangeScope, type Router } from "./webviewHost";

export const TASK_PANEL_VIEW_TYPE = "agentOrchestrator.task";

interface OpenPanel { panel: vscode.WebviewPanel; connection: WebviewConnection }

/** One editor tab per task ("Task #12"), restored after a window reload. */
export class TaskPanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private readonly panels = new Map<string, OpenPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly router: Router,
    private readonly titleFor: (taskId: string) => string | undefined
  ) {}

  open(taskId: string) {
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(TASK_PANEL_VIEW_TYPE, this.titleFor(taskId) ?? "Task", vscode.ViewColumn.Active, webviewOptions(this.extensionUri));
    this.attach(panel, taskId);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
    const taskId = typeof (state as { taskId?: unknown } | undefined)?.taskId === "string" ? (state as { taskId: string }).taskId : undefined;
    if (!taskId || !this.titleFor(taskId)) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.extensionUri);
    this.attach(panel, taskId);
  }

  notify(scopes: ChangeScope[], taskIds?: string[]) {
    for (const [taskId, open] of this.panels) {
      if (!taskIds || taskIds.includes(taskId)) open.connection.notify(scopes, [taskId]);
    }
  }

  dispose() {
    for (const open of this.panels.values()) open.panel.dispose();
    this.panels.clear();
  }

  private attach(panel: vscode.WebviewPanel, taskId: string) {
    panel.title = this.titleFor(taskId) ?? panel.title;
    panel.iconPath = { light: vscode.Uri.joinPath(this.extensionUri, "media", "agents-light.svg"), dark: vscode.Uri.joinPath(this.extensionUri, "media", "agents-dark.svg") };
    panel.webview.html = renderHtml(panel.webview, this.extensionUri, "task", panel.title);
    const connection = new WebviewConnection(panel.webview, "task", this.router, () => panel.visible, () => ({ taskId }));
    this.panels.set(taskId, { panel, connection });
    const viewState = panel.onDidChangeViewState(() => { if (panel.visible) connection.flush(); });
    panel.onDidDispose(() => {
      viewState.dispose();
      connection.dispose();
      if (this.panels.get(taskId)?.panel === panel) this.panels.delete(taskId);
    });
  }
}
