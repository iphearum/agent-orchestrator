import * as vscode from "vscode";
import { AgentDatabase } from "./database";

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private emitter = new vscode.EventEmitter<AgentTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private db: AgentDatabase) {}

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AgentTreeItem[] {
    return this.db.listAgents().map(
      a =>
        new AgentTreeItem(
          a.name,
          `${a.description} • ${a.skills.join(", ")}`,
          vscode.TreeItemCollapsibleState.None
        )
    );
  }
}

class AgentTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    tooltip: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon("hubot");
  }
}
