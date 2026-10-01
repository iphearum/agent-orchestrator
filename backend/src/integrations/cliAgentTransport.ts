import { spawn } from "child_process";
import type { AgentDefinition } from "../core/types";
import type { RemoteAgentContext, RemoteAgentRunner } from "../core/orchestrator";

/**
 * A coding-agent CLI that can own an agent's task, configured in agentOrchestrator.cliAgents.
 * Presets fill in the command line for known CLIs; "custom" uses command/args as given.
 */
export interface CliAgentLink {
  id: string;
  name: string;
  preset?: "claude-code" | "codex" | "custom";
  command?: string;
  /** Custom args. "{prompt}" is replaced by the task; without it the task is appended as the last argument. */
  args?: string[];
  /** How to read the output: plain text, or Claude Code's stream-json events. */
  output?: "text" | "claude-stream-json";
  timeoutMs?: number;
}

export interface CliInvocation { command: string; args: string[]; output: "text" | "claude-stream-json"; stdin?: string }

type ApprovalMode = NonNullable<RemoteAgentContext["approvalMode"]>;

/**
 * Builds the command line. The approval mode maps onto the CLI's own permission settings:
 * ask = look but don't change anything, approve = may edit files, full = no safeguards.
 * On Windows the prompt goes over stdin, because .cmd shims need a shell and the prompt must never pass through one.
 */
export function buildInvocation(link: CliAgentLink, prompt: string, approvalMode: ApprovalMode = "ask", platform = process.platform): CliInvocation {
  const viaStdin = platform === "win32";
  switch (link.preset) {
    case "claude-code": {
      const permission = { ask: "plan", approve: "acceptEdits", full: "bypassPermissions" }[approvalMode];
      const args = ["-p", ...(viaStdin ? [] : [prompt]), "--output-format", "stream-json", "--verbose", "--permission-mode", permission];
      return { command: link.command || "claude", args, output: "claude-stream-json", stdin: viaStdin ? prompt : undefined };
    }
    case "codex": {
      const sandbox = { ask: "read-only", approve: "workspace-write", full: "danger-full-access" }[approvalMode];
      return { command: link.command || "codex", args: ["exec", "--sandbox", sandbox, viaStdin ? "-" : prompt], output: "text", stdin: viaStdin ? prompt : undefined };
    }
    default: {
      if (!link.command?.trim()) throw new Error(`CLI agent '${link.name}' needs a command.`);
      const template = link.args ?? [];
      const hasPlaceholder = template.some(arg => arg.includes("{prompt}"));
      if (viaStdin) {
        // The prompt moves to stdin, so drop its argument and the flag that introduced it ("--message {prompt}").
        const args = template.filter((arg, index) => !arg.includes("{prompt}") && !(template[index + 1] === "{prompt}" && arg.startsWith("-")));
        return { command: link.command, args, output: link.output ?? "text", stdin: prompt };
      }
      const args = hasPlaceholder ? template.map(arg => arg.split("{prompt}").join(prompt)) : [...template, prompt];
      return { command: link.command, args, output: link.output ?? "text" };
    }
  }
}

type Progress = NonNullable<RemoteAgentContext["onProgress"]>;

/** Reads Claude Code `--output-format stream-json` lines: tool use, tool results and the final result. */
export class ClaudeStreamParser {
  result?: string;
  error?: string;
  private readonly tools = new Map<string, { name: string; path?: string }>();
  private lastText = "";

  constructor(private readonly onProgress?: Progress) {}

  line(raw: string) {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          const input = block.input ?? {};
          const path = [input.file_path, input.path, input.pattern, input.command].find(value => typeof value === "string") as string | undefined;
          this.tools.set(block.id, { name: String(block.name ?? "tool"), path: path?.slice(0, 160) });
          this.onProgress?.({ kind: "tool-start", id: block.id, toolName: String(block.name ?? "tool"), path: path?.slice(0, 160) });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.lastText = block.text;
          this.onProgress?.({ kind: "message", text: block.text });
        }
      }
    } else if (event?.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = this.tools.get(block.tool_use_id);
        const text = typeof block.content === "string" ? block.content
          : Array.isArray(block.content) ? block.content.map((part: any) => part?.text ?? "").join("\n") : "";
        this.onProgress?.({ kind: "tool-end", id: block.tool_use_id, toolName: tool?.name, path: tool?.path, text: text.slice(0, 4000), failed: block.is_error === true });
      }
    } else if (event?.type === "result") {
      if (event.is_error || (typeof event.subtype === "string" && event.subtype.startsWith("error"))) this.error = String(event.result ?? event.subtype ?? "The CLI reported an error.");
      else this.result = String(event.result ?? this.lastText ?? "");
    }
  }

  finalText() { return this.result ?? this.lastText; }
}

/** Runs an agent's task through a configured coding-agent CLI inside the workspace. */
export class CliAgentTransport implements RemoteAgentRunner {
  constructor(
    private readonly resolveLink: (linkId: string) => CliAgentLink | undefined,
    private readonly workspaceRoot: () => string | undefined
  ) {}

  run(agent: AgentDefinition, instruction: string, context: RemoteAgentContext): Promise<string> {
    const link = agent.cliLinkId ? this.resolveLink(agent.cliLinkId) : undefined;
    if (!link) return Promise.reject(new Error(`CLI agent '${agent.cliLinkId}' is not configured (agentOrchestrator.cliAgents).`));
    const cwd = this.workspaceRoot();
    if (!cwd) return Promise.reject(new Error("Open a workspace folder before running a CLI agent."));
    const invocation = buildInvocation(link, instruction, context.approvalMode ?? "ask");
    const timeoutMs = Math.max(10_000, Math.min(60 * 60_000, link.timeoutMs ?? 15 * 60_000));

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        // .cmd/.bat shims need a shell on Windows; the prompt is on stdin there, never in the command line.
        shell: process.platform === "win32"
      });
      const parser = invocation.output === "claude-stream-json" ? new ClaudeStreamParser(context.onProgress) : undefined;
      let stdout = "", stderr = "", pending = "";
      const cap = (text: string) => text.length > 400_000 ? text.slice(-400_000) : text;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${link.name} did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`)); }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = cap(stdout + chunk);
        if (!parser) return;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.forEach(line => parser.line(line));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = cap(stderr + chunk); });
      child.on("error", error => {
        clearTimeout(timer);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new Error(missing ? `'${invocation.command}' was not found. Install ${link.name} and make sure it is on PATH for VS Code.` : error.message));
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (parser && pending) parser.line(pending);
        const answer = parser ? parser.finalText() : stdout.trim();
        if (parser?.error) reject(new Error(`${link.name}: ${parser.error}`));
        else if (code !== 0 && !answer) reject(new Error(`${link.name} exited with code ${code}: ${(stderr || stdout).trim().slice(-1500)}`));
        else resolve(answer || `(${link.name} finished without output)`);
      });
      if (invocation.stdin !== undefined) child.stdin.write(invocation.stdin);
      child.stdin.end();
    });
  }
}
