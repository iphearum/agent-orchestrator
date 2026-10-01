import * as vscode from "vscode";
import { renderHtml, webviewOptions, WebviewConnection, type ChangeScope, type Router } from "./webviewHost";

export const SIDEBAR_VIEW_ID = "agentOrchestrator.sidebar";

/** The Activity Bar sidebar: workspace, navigation, agents, active tasks, recent conversations. */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private connection?: WebviewConnection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly router: Router) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderHtml(view.webview, this.extensionUri, "sidebar", "Agent Orchestration");
    this.connection?.dispose();
    const connection = new WebviewConnection(view.webview, "sidebar", this.router, () => view.visible);
    this.connection = connection;
    this.disposables.push(
      view.onDidChangeVisibility(() => { if (view.visible) connection.flush(); }),
      view.onDidDispose(() => {
        connection.dispose();
        if (this.connection === connection) this.connection = undefined;
      })
    );
  }

  notify(scopes: ChangeScope[], taskIds?: string[]) { this.connection?.notify(scopes, taskIds); }

  dispose() {
    this.connection?.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
