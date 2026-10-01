import * as vscode from "vscode";
import { RunEvent } from "../core/orchestrator";

export class AgentPanel {
  private panel?: vscode.WebviewPanel;

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "agentOrchestrator",
      "Agent Orchestrator",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  post(event: RunEvent) {
    this.panel?.webview.postMessage(event);
  }

  private html(): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
.event { border-left: 2px solid var(--vscode-editorInfo-foreground); padding: 8px 10px; margin: 8px 0; }
.agent { font-weight: 700; }
.kind { opacity: .7; margin-left: 8px; }
pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h2>Agent Orchestrator</h2>
<div id="events"></div>
<script>
const root = document.getElementById('events');
window.addEventListener('message', event => {
  const e = event.data;
  const div = document.createElement('div');
  div.className = 'event';
  const head = document.createElement('div');
  head.innerHTML = '<span class="agent"></span><span class="kind"></span>';
  head.querySelector('.agent').textContent = e.agentId;
  head.querySelector('.kind').textContent = e.type;
  const body = document.createElement('pre');
  body.textContent = e.text;
  div.appendChild(head);
  div.appendChild(body);
  root.prepend(div);
});
</script>
</body>
</html>`;
  }
}
