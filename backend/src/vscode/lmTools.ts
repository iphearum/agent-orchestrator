import * as vscode from "vscode";
import { matchesAny, type ExternalTool, type ExternalToolHost } from "../core/externalTools";

export interface ExternalToolSettings {
  enabled: boolean;
  /** Which registered tools count as external agent tools, e.g. ["mcp_*"]. */
  toolPatterns: string[];
  /** Per-agent grants: agent id (or "*") → tool name patterns. */
  agentTools: Record<string, string[]>;
  /** Tools that may run without asking, e.g. read-only ones. */
  autoApprove: string[];
}

export function readExternalToolSettings(): ExternalToolSettings {
  const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
  return {
    enabled: cfg.get<boolean>("externalTools.enabled", true),
    toolPatterns: cfg.get<string[]>("externalTools.toolPatterns", ["mcp_*"]),
    agentTools: cfg.get<Record<string, string[]>>("externalTools.agentTools", { "*": ["*"] }),
    autoApprove: cfg.get<string[]>("externalTools.autoApprove", [])
  };
}

/**
 * External tools through VS Code's language model tool registry. MCP servers configured in VS Code
 * (mcp.json) show up here, so VS Code handles starting them, trust and sign-in.
 */
export class VsCodeToolHost implements ExternalToolHost {
  constructor(private readonly settings: () => ExternalToolSettings = readExternalToolSettings) {}

  /** Every registered tool that matches the patterns, before per-agent grants. */
  available(): ExternalTool[] {
    const cfg = this.settings();
    if (!cfg.enabled || !vscode.lm?.tools) return [];
    return vscode.lm.tools
      .filter(tool => matchesAny(tool.name, cfg.toolPatterns))
      .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  forAgent(agentId: string): ExternalTool[] {
    const grants = this.settings().agentTools;
    const patterns = grants[agentId] ?? grants["*"] ?? [];
    return patterns.length ? this.available().filter(tool => matchesAny(tool.name, patterns)) : [];
  }

  autoApproved(name: string) { return matchesAny(name, this.settings().autoApprove); }

  async invoke(name: string, input: object): Promise<string> {
    const cancel = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cancel.cancel(), 120_000);
    try {
      const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }, cancel.token);
      const text = result.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : safeJson(part)).join("\n").trim();
      return text || `(${name} returned no text)`;
    } finally {
      clearTimeout(timer);
      cancel.dispose();
    }
  }
}

/** Lists every tool VS Code knows about and which ones agents can use, so patterns are easy to get right. */
export async function showExternalTools(host: VsCodeToolHost) {
  const settings = readExternalToolSettings();
  const all = vscode.lm?.tools ?? [];
  if (!all.length) {
    void vscode.window.showInformationMessage("No tools are registered in VS Code yet. Add MCP servers with the “MCP: Add Server” command, then try again.");
    return;
  }
  const usable = new Set(host.available().map(tool => tool.name));
  const items = [...all].sort((a, b) => Number(usable.has(b.name)) - Number(usable.has(a.name)) || a.name.localeCompare(b.name)).map(tool => ({
    label: `${usable.has(tool.name) ? "$(check)" : "$(circle-slash)"} ${tool.name}`,
    description: usable.has(tool.name) ? "available to agents" : settings.enabled ? "not matched by externalTools.toolPatterns" : "external tools are turned off",
    detail: tool.description
  }));
  await vscode.window.showQuickPick(items, { title: `External tools: ${usable.size} of ${all.length} available to agents`, placeHolder: "Adjust agentOrchestrator.externalTools.* settings to change which tools agents get", matchOnDetail: true });
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
