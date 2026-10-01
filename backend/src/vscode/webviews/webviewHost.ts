import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { MethodName, Surface, ToHost, ToWebview } from "../../shared/protocol";

export type Router = (method: MethodName, params: unknown) => Promise<unknown>;
export type ChangeScope = Extract<ToWebview, { kind: "changed" }>["scopes"][number];

/** Thrown by handlers for errors the webview should show as-is. */
export class RpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")] };
}

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: Surface, title: string): string {
  const nonce = randomBytes(18).toString("base64");
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", name));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("main.css")}">
<title>${title.replace(/[<&"]/g, "")}</title>
</head>
<body>
<div id="root" data-surface="${surface}"></div>
<script nonce="${nonce}" src="${asset("robot-runtime.js")}"></script>
<script nonce="${nonce}" type="module" src="${asset("main.js")}"></script>
</body>
</html>`;
}

/**
 * Connects one webview to the RPC router and the change feed. Change notices are coalesced
 * and held back while the view is hidden, then sent once when it becomes visible again.
 */
export class WebviewConnection implements vscode.Disposable {
  private ready = false;
  private pendingScopes = new Set<ChangeScope>();
  private pendingTaskIds = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly surface: Surface,
    private readonly router: Router,
    private readonly isVisible: () => boolean,
    private readonly context: () => { taskId?: string } = () => ({})
  ) {
    this.disposables.push(webview.onDidReceiveMessage((message: ToHost) => void this.receive(message)));
  }

  /** Queue a change notice; flushed at most every 250 ms. */
  notify(scopes: ChangeScope[], taskIds: string[] = []) {
    scopes.forEach(scope => this.pendingScopes.add(scope));
    taskIds.forEach(id => this.pendingTaskIds.add(id));
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250);
  }

  /** Call when the view becomes visible, so it catches up on what it missed. */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.ready || !this.isVisible() || !this.pendingScopes.size) return;
    const message: ToWebview = { kind: "changed", scopes: [...this.pendingScopes], taskIds: this.pendingTaskIds.size ? [...this.pendingTaskIds] : undefined };
    this.pendingScopes.clear();
    this.pendingTaskIds.clear();
    void this.webview.postMessage(message);
  }

  sendInit() {
    const message: ToWebview = { kind: "init", surface: this.surface, context: this.context() };
    void this.webview.postMessage(message);
  }

  dispose() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async receive(message: ToHost) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "ready") {
      this.ready = true;
      this.sendInit();
      return;
    }
    if (message.kind !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
    let reply: ToWebview;
    try {
      reply = { kind: "response", id: message.id, ok: true, result: await this.router(message.method, message.params) ?? null };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "internal";
      reply = { kind: "response", id: message.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
    void this.webview.postMessage(reply);
  }
}
