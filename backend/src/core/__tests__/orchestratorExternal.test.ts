import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../persistence/database";
import { AgentDecisionEngine } from "../decision";
import { Orchestrator, type ToolApprovalRequest } from "../orchestrator";
import type { ExternalTool, ExternalToolHost } from "../externalTools";
import type { ChatResponse } from "../types";

let dir: string;
let db: AgentDatabase;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-ext-")); db = new AgentDatabase(dir); db.seedAgents(); });
afterEach(() => { db.connection.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const catalog: ExternalTool[] = [
  { name: "mcp_github_list_issues", description: "List issues in a GitHub repository", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "mcp_postgres_query", description: "Run a SQL query against Postgres" },
  { name: "mcp_fetch_fetch", description: "Fetch a URL" }
];

/** A model that replays scripted turns and records which tools it was offered. */
function scriptedModel(turns: ChatResponse[]) {
  const offered: string[][] = [];
  return {
    offered,
    chat: async (_messages: unknown, tools: Array<{ function: { name: string } }>) => {
      offered.push(tools.map(tool => tool.function.name));
      return turns.shift() ?? { content: "done", toolCalls: [] };
    }
  };
}

function host(invoked: Array<{ name: string; input: object }>, autoApprove: string[] = []): ExternalToolHost {
  return {
    forAgent: () => catalog,
    autoApproved: name => autoApprove.includes(name),
    invoke: async (name, input) => { invoked.push({ name, input }); return "#12 Login returns 500"; }
  };
}

const callIssues = { content: null, toolCalls: [{ id: "c1", type: "function" as const, function: { name: "mcp_github_list_issues", arguments: '{"repo":"acme/gateway"}' } }] };

describe("orchestrator with external tools", () => {
  it("offers only relevant external tools plus find_tools, and runs them in full access", async () => {
    const invoked: Array<{ name: string; input: object }> = [];
    const model = scriptedModel([callIssues, { content: "Issue #12 is open.", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 2, maxDelegationsPerTask: 4, contextRecentMessages: 6 },
      undefined, undefined, undefined, undefined, undefined, undefined, host(invoked));
    const answer = await orchestrator.runRoot("List the open github issues", "coder", false, { approvalMode: "full" });

    expect(answer).toBe("Issue #12 is open.");
    expect(model.offered[0]).toContain("find_tools");
    expect(model.offered[0]).toContain("mcp_github_list_issues");
    expect(model.offered[0]).not.toContain("mcp_fetch_fetch");
    expect(invoked).toEqual([{ name: "mcp_github_list_issues", input: { repo: "acme/gateway" } }]);
    const run = db.connection.prepare("SELECT tool_name, result_json FROM tool_runs").get() as { tool_name: string; result_json: string };
    expect(run).toEqual({ tool_name: "mcp_github_list_issues", result_json: "#12 Login returns 500" });
  });

  it("asks before running an external tool, and does not run it when declined", async () => {
    const invoked: Array<{ name: string; input: object }> = [];
    const approvals: ToolApprovalRequest[] = [];
    const model = scriptedModel([callIssues, { content: "Okay, skipped.", toolCalls: [] }]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 2, maxDelegationsPerTask: 4, contextRecentMessages: 6 },
      async request => { approvals.push(request); return false; }, undefined, undefined, undefined, undefined, undefined, host(invoked));
    await orchestrator.runRoot("List the open github issues", "coder", false, { approvalMode: "approve" });

    expect(approvals).toHaveLength(1);
    expect(approvals[0].toolName).toBe("mcp_github_list_issues");
    expect(approvals[0].detail).toContain("external tool");
    expect(invoked).toEqual([]);
  });

  it("find_tools enables matching tools for the next turn", async () => {
    const invoked: Array<{ name: string; input: object }> = [];
    const model = scriptedModel([
      { content: null, toolCalls: [{ id: "f1", type: "function", function: { name: "find_tools", arguments: '{"query":"run a sql query"}' } }] },
      { content: "Found the query tool.", toolCalls: [] }
    ]);
    const orchestrator = new Orchestrator(db, model as any, undefined, new AgentDecisionEngine(), { layaEnabled: false, maxDelegationDepth: 2, maxDelegationsPerTask: 4, contextRecentMessages: 6 },
      undefined, undefined, undefined, undefined, undefined, undefined, host(invoked, ["mcp_postgres_query"]));
    await orchestrator.runRoot("Check the users table", "coder", false, { approvalMode: "ask" });

    expect(model.offered[0]).not.toContain("mcp_postgres_query");
    expect(model.offered[1]).toContain("mcp_postgres_query");
  });
});
