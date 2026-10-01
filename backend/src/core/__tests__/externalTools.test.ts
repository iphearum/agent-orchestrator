import { describe, expect, it } from "bun:test";
import { describeFound, matchesAny, rankTools, toFunctionName, toFunctionSchema, type ExternalTool } from "../externalTools";

const tools: ExternalTool[] = [
  { name: "mcp_github_list_issues", description: "List issues in a GitHub repository" },
  { name: "mcp_github_create_pull_request", description: "Open a pull request" },
  { name: "mcp_postgres_query", description: "Run a read-only SQL query against Postgres" },
  { name: "mcp_fetch_fetch", description: "Fetch a URL and return its content as markdown" }
];

describe("external tools", () => {
  it("matches glob patterns case-insensitively", () => {
    expect(matchesAny("mcp_github_list_issues", ["mcp_*"])).toBe(true);
    expect(matchesAny("mcp_github_list_issues", ["mcp_postgres_*"])).toBe(false);
    expect(matchesAny("copilot_readFile", ["mcp_*"])).toBe(false);
    expect(matchesAny("MCP_Fetch_Fetch", ["mcp_fetch_*"])).toBe(true);
    expect(matchesAny("a.b", ["a.b"])).toBe(true);
    expect(matchesAny("axb", ["a.b"])).toBe(false);
  });

  it("ranks tools by relevance and returns nothing for unrelated text", () => {
    expect(rankTools(tools, "list the open github issues", 2).map(t => t.name)).toEqual(["mcp_github_list_issues", "mcp_github_create_pull_request"]);
    expect(rankTools(tools, "run an sql query", 1).map(t => t.name)).toEqual(["mcp_postgres_query"]);
    expect(rankTools(tools, "fix the login bug", 3)).toEqual([]);
  });

  it("produces valid function names and schemas", () => {
    expect(toFunctionName("mcp_server.tool name")).toBe("mcp_server_tool_name");
    const long = toFunctionName(`mcp_${"x".repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
    const schema = toFunctionSchema(tools[0]);
    expect(schema.function.parameters).toEqual({ type: "object", properties: {} });
    expect(schema.function.description).toContain("mcp_github_list_issues");
  });

  it("tells the agent what find_tools enabled", () => {
    expect(describeFound([tools[3]], "fetch a page")).toContain("- mcp_fetch_fetch: Fetch a URL");
    expect(describeFound([], "zzz")).toContain('No external tools match "zzz"');
  });
});
