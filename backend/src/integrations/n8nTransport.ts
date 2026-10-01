import { AgentDefinition } from "../core/types";
import { RemoteAgentRunner } from "../core/orchestrator";

export interface N8nAgentLink { id: string; name: string; webhookUrl: string; secretId?: string; }
export interface N8nCredentials { link: N8nAgentLink; bearerToken?: string; }

/** Executes an agent-linked n8n workflow through its webhook and returns the workflow result. */
export class N8nTransport implements RemoteAgentRunner {
  constructor(private readonly resolveCredentials: (linkId: string) => Promise<N8nCredentials | undefined>, private readonly timeoutMs = 120_000) {}

  async run(agent: AgentDefinition, instruction: string, context: { taskId: string; rootTaskId: string; conversationId?: string; depth: number }): Promise<string> {
    if (!agent.n8nLinkId) throw new Error(`Agent '${agent.name}' has no n8n link.`);
    const credentials = await this.resolveCredentials(agent.n8nLinkId);
    if (!credentials) throw new Error(`n8n link '${agent.n8nLinkId}' is not configured.`);
    let endpoint: URL;
    try { endpoint = new URL(credentials.link.webhookUrl); }
    catch { throw new Error(`n8n link '${credentials.link.name}' has an invalid webhook URL.`); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new Error("n8n webhook URLs must use HTTPS (HTTP is allowed for localhost).");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("n8n request timed out.")), this.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credentials.bearerToken ? { authorization: `Bearer ${credentials.bearerToken}` } : {})
        },
        body: JSON.stringify({
          type: "agent.execute",
          requestId: context.taskId,
          rootTaskId: context.rootTaskId,
          conversationId: context.conversationId,
          depth: context.depth,
          agent: { id: agent.id, name: agent.name, description: agent.description },
          instruction
        }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`n8n returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
      if (!body.trim()) return "n8n workflow completed.";
      let data: unknown;
      try { data = JSON.parse(body); } catch { return body; }
      if (Array.isArray(data) && data.length === 1 && data[0]?.json) data = data[0].json;
      if (data && typeof data === "object") {
        const result = data as Record<string, unknown>;
        const value = result.output ?? result.response ?? result.result ?? result.text;
        if (typeof value === "string") return value;
      }
      return typeof data === "string" ? data : JSON.stringify(data);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`n8n request timed out after ${this.timeoutMs / 1000}s.`);
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
