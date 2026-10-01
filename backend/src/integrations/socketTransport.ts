import * as vscode from "vscode";
import { AgentDefinition } from "../core/types";
import { RemoteAgentRunner } from "../core/orchestrator";

export interface SocketAgentLink { id: string; name: string; url: string; }
export interface SocketCredentials { link: SocketAgentLink; bearerToken?: string; }

interface PendingRequest {
  linkId: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Persistent WebSocket request/response transport for agents hosted by an external runtime. */
export class SocketAgentTransport implements RemoteAgentRunner, vscode.Disposable {
  private readonly sockets = new Map<string, Promise<WebSocket>>();
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(
    private readonly resolveCredentials: (linkId: string) => Promise<SocketCredentials | undefined>,
    private readonly timeoutMs = 120_000
  ) {}

  async run(agent: AgentDefinition, instruction: string, context: { taskId: string; rootTaskId: string; conversationId?: string; depth: number }): Promise<string> {
    if (!agent.socketLinkId) throw new Error(`Agent '${agent.name}' has no socket link.`);
    const credentials = await this.resolveCredentials(agent.socketLinkId);
    if (!credentials) throw new Error(`Socket link '${agent.socketLinkId}' is not configured.`);
    const socket = await this.connect(credentials.link);
    const requestId = context.taskId;
    const result = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Socket agent '${agent.name}' timed out after ${this.timeoutMs / 1000}s.`));
      }, this.timeoutMs);
      this.pending.set(requestId, { linkId: credentials.link.id, resolve, reject, timeout });
    });
    try {
      socket.send(JSON.stringify({
        type: "agent.execute",
        requestId,
        taskId: context.taskId,
        rootTaskId: context.rootTaskId,
        conversationId: context.conversationId,
        depth: context.depth,
        agent: { id: agent.id, name: agent.name, description: agent.description, skills: agent.skills },
        instruction,
        ...(credentials.bearerToken ? { auth: { bearerToken: credentials.bearerToken } } : {})
      }));
    } catch (error) {
      this.finish(requestId, undefined, error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    for (const [requestId] of this.pending) this.finish(requestId, undefined, new Error("Socket transport was disposed."));
    for (const socketPromise of this.sockets.values()) void socketPromise.then(socket => socket.close(1000, "Extension deactivated")).catch(() => undefined);
    this.sockets.clear();
  }

  private connect(link: SocketAgentLink): Promise<WebSocket> {
    const cached = this.sockets.get(link.id);
    if (cached) return cached.then(socket => {
      if (socket.readyState === WebSocket.OPEN) return socket;
      this.sockets.delete(link.id);
      return this.open(link);
    });
    return this.open(link);
  }

  private open(link: SocketAgentLink): Promise<WebSocket> {
    if (this.disposed) return Promise.reject(new Error("Socket transport is shut down."));
    let endpoint: URL;
    try { endpoint = new URL(link.url); }
    catch { return Promise.reject(new Error(`Socket link '${link.name}' has an invalid URL.`)); }
    if (endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))) {
      return Promise.reject(new Error("Socket links must use WSS (WS is allowed for localhost)."));
    }

    const promise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Could not connect to socket link '${link.name}' within 10 seconds.`));
      }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(socket); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to socket link '${link.name}'.`));
      }, { once: true });
      socket.addEventListener("message", event => this.onMessage(event.data));
      socket.addEventListener("close", event => {
        clearTimeout(timeout);
        this.sockets.delete(link.id);
        const reason = event.reason || `Socket link '${link.name}' closed (code ${event.code}).`;
        for (const [requestId, pending] of this.pending) if (pending.linkId === link.id) this.finish(requestId, undefined, new Error(reason));
      });
    });
    this.sockets.set(link.id, promise);
    void promise.catch(() => { if (this.sockets.get(link.id) === promise) this.sockets.delete(link.id); });
    return promise;
  }

  private onMessage(raw: unknown) {
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; }
    catch { return; }
    const requestId = typeof message.requestId === "string" ? message.requestId : typeof message.id === "string" ? message.id : undefined;
    if (!requestId) return;
    if (message.type === "agent.progress") return;
    if (message.type !== "agent.result" && message.type !== "agent.error") return;
    if (message.type === "agent.error") {
      this.finish(requestId, undefined, new Error(typeof message.error === "string" ? message.error : "Remote agent failed."));
      return;
    }
    const output = message.output ?? message.result ?? message.response;
    this.finish(requestId, typeof output === "string" ? output : JSON.stringify(output ?? "Remote agent completed."));
  }

  private finish(requestId: string, value?: string, error?: Error) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else pending.resolve(value ?? "");
  }
}
