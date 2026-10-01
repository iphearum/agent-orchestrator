import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";

export interface MonitorSnapshotProvider { (): Record<string, unknown>; }

/** Shared agent-network and runtime dashboard for the sidebar and full editor view. */
export class MonitorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private timer?: ReturnType<typeof setInterval>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly snapshot: MonitorSnapshotProvider) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    this.listen(view.webview);
    this.startRefresh();
    this.disposables.push(view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      this.stopIfUnused();
    }));
  }

  openPanel() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel("agentOrchestrator.monitorDashboard", "Agent Orchestrator Monitor", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    });
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    this.listen(panel.webview);
    this.startRefresh();
    this.disposables.push(panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      this.stopIfUnused();
    }));
  }

  refresh() {
    const payload = { type: "snapshot", value: this.snapshot() };
    if (this.view?.visible) void this.view.webview.postMessage(payload);
    if (this.panel?.visible) void this.panel.webview.postMessage(payload);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
    this.panel?.dispose();
  }

  private listen(webview: vscode.Webview) {
    this.disposables.push(webview.onDidReceiveMessage(message => {
      if (message?.type === "ready" || message?.type === "refresh") this.refresh();
      else if (message?.type === "openWorkspace") void vscode.commands.executeCommand("workbench.action.files.openFolder");
      else if (message?.type === "openChat") void vscode.commands.executeCommand("agentOrchestrator.open");
    }));
  }

  private startRefresh() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 4000);
    this.refresh();
  }

  private stopIfUnused() {
    if (this.view || this.panel || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private html(webview: vscode.Webview) {
    const nonce = randomBytes(18).toString("base64");
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const template = readFileSync(vscode.Uri.joinPath(media, "monitorView.html").fsPath, "utf8");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "monitorView.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "monitorView.js"));
    return template
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{cssUri}}", cssUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString());
  }
}
