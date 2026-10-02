import * as vscode from "vscode";
import { renderHtml, webviewOptions, WebviewConnection, type ChangeScope, type Router } from "./webviewHost";

export const OVERVIEW_VIEW_TYPE = "agentOrchestrator.overview";

/** The single "Overview" editor tab: workspace-wide dashboard, restored after a window reload. */
export class OverviewPanel implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private open?: { panel: vscode.WebviewPanel; connection: WebviewConnection };

  constructor(private readonly extensionUri: vscode.Uri, private readonly router: Router) {}

  show() {
    if (this.open) {
      this.open.panel.reveal(this.open.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    this.attach(vscode.window.createWebviewPanel(OVERVIEW_VIEW_TYPE, "Overview", vscode.ViewColumn.Active, webviewOptions(this.extensionUri)));
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
    if (this.open) { panel.dispose(); return; }
    panel.webview.options = webviewOptions(this.extensionUri);
    this.attach(panel);
  }

  notify(scopes: ChangeScope[], taskIds?: string[]) { this.open?.connection.notify(scopes, taskIds); }

  dispose() { this.open?.panel.dispose(); }

  /** Re-render the page (e.g. after agentOrchestrator.robotModel changes). */
  reload() { if (this.open) this.open.panel.webview.html = renderHtml(this.open.panel.webview, this.extensionUri, "overview", "Overview"); }

  private attach(panel: vscode.WebviewPanel) {
    panel.title = "Overview";
    panel.iconPath = { light: vscode.Uri.joinPath(this.extensionUri, "media", "agents-light.svg"), dark: vscode.Uri.joinPath(this.extensionUri, "media", "agents-dark.svg") };
    panel.webview.html = renderHtml(panel.webview, this.extensionUri, "overview", "Overview");
    const connection = new WebviewConnection(panel.webview, "overview", this.router, () => panel.visible);
    this.open = { panel, connection };
    const viewState = panel.onDidChangeViewState(() => { if (panel.visible) connection.flush(); });
    panel.onDidDispose(() => {
      viewState.dispose();
      connection.dispose();
      if (this.open?.panel === panel) this.open = undefined;
    });
  }
}
