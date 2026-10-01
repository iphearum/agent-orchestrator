import * as vscode from "vscode";
import type { HealthView } from "../shared/protocol";

/** Native status bar items from the design: agents running, tasks active, Laya, SQLite. */
export class OrchestratorStatusBar implements vscode.Disposable {
  private readonly agents = vscode.window.createStatusBarItem("agentOrchestrator.agents", vscode.StatusBarAlignment.Right, 104);
  private readonly tasks = vscode.window.createStatusBarItem("agentOrchestrator.tasks", vscode.StatusBarAlignment.Right, 103);
  private readonly laya = vscode.window.createStatusBarItem("agentOrchestrator.laya", vscode.StatusBarAlignment.Right, 102);
  private readonly sqlite = vscode.window.createStatusBarItem("agentOrchestrator.sqlite", vscode.StatusBarAlignment.Right, 101);

  constructor() {
    this.agents.name = "Agent Orchestrator: Agents";
    this.tasks.name = "Agent Orchestrator: Tasks";
    this.laya.name = "Agent Orchestrator: Laya";
    this.sqlite.name = "Agent Orchestrator: SQLite";
    this.agents.command = { title: "Show agents", command: "workbench.view.extension.agentOrchestrator" };
    this.tasks.command = { title: "Open latest task", command: "agentOrchestrator.openLatestTask" };
    this.laya.command = { title: "Test Laya connection", command: "agentOrchestrator.testLaya" };
    for (const item of [this.agents, this.tasks, this.laya, this.sqlite]) item.show();
  }

  update(health: HealthView) {
    this.agents.text = `$(hubot) Agents: ${health.agentsRunning} running`;
    this.agents.tooltip = health.agentsRunning ? `${health.agentsRunning} agent(s) are working right now.` : "No agent is working right now.";
    this.tasks.text = `$(tasklist) Tasks: ${health.tasksActive} active`;
    this.tasks.tooltip = "Tasks running in this window. Click to open the latest task.";

    const laya = health.laya;
    const layaText = laya.status === "unconfigured" ? "not set" : laya.status;
    this.laya.text = `$(${laya.status === "online" ? "pass-filled" : laya.status === "offline" || laya.status === "paused" ? "warning" : "circle-outline"}) Laya: ${layaText}`;
    this.laya.tooltip = laya.status === "paused"
      ? `Laya is paused${laya.pausedAt ? ` since ${new Date(laya.pausedAt).toLocaleTimeString()}` : ""}: decisions use the fallback and Laya is not called again until you resume it.\n${laya.lastError ?? ""}\nClick to test the connection; it resumes when Laya answers.`
      : laya.status === "offline" ? `Laya is unreachable; decisions use the configured fallback.\n${laya.lastError ?? ""}`
      : laya.status === "unconfigured" ? "No Laya endpoint is set (agentOrchestrator.layaEndpoint), so agents use the fallback decisions."
        : laya.status === "unknown" ? "Laya has not been contacted yet in this window. Click to test the connection."
          : laya.status === "disabled" ? "Laya is turned off (agentOrchestrator.layaEnabled)." : "Laya answered the last decision request.";
    this.laya.backgroundColor = laya.status === "offline" || laya.status === "paused" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

    this.sqlite.text = `$(database) SQLite: ${health.sqlite.status}`;
    this.sqlite.tooltip = health.sqlite.error ?? "The runtime database is open.";
    this.sqlite.backgroundColor = health.sqlite.status === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  }

  dispose() {
    for (const item of [this.agents, this.tasks, this.laya, this.sqlite]) item.dispose();
  }
}
