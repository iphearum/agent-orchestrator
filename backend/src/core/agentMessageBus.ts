import * as vscode from "vscode";

export type AgentMessageKind = "ask" | "delegate" | "response";
export interface AgentMessageEvent {
  id: string;
  taskId: string;
  conversationId?: string;
  fromAgentId: string;
  toAgentId: string;
  kind: AgentMessageKind;
  content: string;
}

/** In-process communication channel; message records are also persisted by the orchestrator. */
export class AgentMessageBus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AgentMessageEvent>();
  readonly onDidMessage = this.emitter.event;
  publish(message: AgentMessageEvent) { this.emitter.fire(message); }
  dispose() { this.emitter.dispose(); }
}
