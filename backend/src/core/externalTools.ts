// Tools from outside this runtime (MCP servers and other VS Code extensions), described without the VS Code API
// so the orchestrator stays testable. The VS Code adapter lives in vscode/lmTools.ts.

export interface ExternalTool {
  /** Name as registered in VS Code, e.g. "mcp_github_list_issues". */
  name: string;
  description: string;
  inputSchema?: object;
}

export interface ExternalToolHost {
  /** Tools this agent may use: enabled, matching the tool patterns, and granted to the agent. */
  forAgent(agentId: string): ExternalTool[];
  /** Tools the user allowed to run without asking (read-only ones, typically). */
  autoApproved(name: string): boolean;
  invoke(name: string, input: object): Promise<string>;
}

/** Simple glob: `*` matches any run of characters, everything else is literal. Case-insensitive. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`, "i").test(name));
}

/** OpenAI-style function names allow [A-Za-z0-9_-], at most 64 characters. */
export function toFunctionName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return clean.length <= 64 ? clean : `${clean.slice(0, 55)}_${hash(name)}`;
}

export function toFunctionSchema(tool: ExternalTool) {
  return {
    type: "function",
    function: {
      name: toFunctionName(tool.name),
      description: `${tool.description || tool.name} (external tool: ${tool.name})`.slice(0, 1000),
      parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }
    }
  };
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "what", "how", "please", "can", "you", "use", "tool", "tools", "mcp"]);
const terms = (text: string) => [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(term => !STOP.has(term)))];

/** Most relevant tools for a piece of text, by word overlap with the tool's name and description. */
export function rankTools(tools: readonly ExternalTool[], text: string, limit: number): ExternalTool[] {
  const wanted = terms(text);
  if (!wanted.length) return [];
  return tools
    .map(tool => {
      const nameTerms = terms(tool.name.replace(/[_-]/g, " "));
      const descriptionTerms = new Set(terms(tool.description));
      const score = wanted.reduce((sum, term) => sum + (nameTerms.includes(term) ? 3 : 0) + (descriptionTerms.has(term) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(item => item.tool);
}

/** The one tool always offered when external tools exist: search for them, then use what it enables. */
export const FIND_TOOLS_SCHEMA = {
  type: "function",
  function: {
    name: "find_tools",
    description: "Search the external tools (MCP servers and VS Code extensions) available to you, e.g. GitHub, databases, browsers, docs. Matching tools become callable on your next turn.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What you need to do, e.g. 'list github issues' or 'query postgres'." } }, required: ["query"], additionalProperties: false }
  }
};

export function describeFound(found: readonly ExternalTool[], query: string): string {
  if (!found.length) return `No external tools match "${query}". Try other words, or continue with your built-in tools.`;
  return `Now available (call them directly):\n${found.map(tool => `- ${toFunctionName(tool.name)}: ${(tool.description || "").replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`;
}

function escapeRegex(text: string) { return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }

function hash(text: string) {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value.toString(36).slice(0, 8);
}
