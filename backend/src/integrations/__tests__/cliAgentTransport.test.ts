import { describe, expect, it } from "bun:test";
import { buildInvocation, ClaudeStreamParser } from "../cliAgentTransport";

const prompt = 'Fix "login" & run tests; rm -rf /';

describe("buildInvocation", () => {
  it("maps approval modes onto Claude Code permission modes and keeps the prompt one argument", () => {
    expect(buildInvocation({ id: "c", name: "Claude Code", preset: "claude-code" }, prompt, "ask", "linux")).toEqual({
      command: "claude", output: "claude-stream-json", stdin: undefined,
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"]
    });
    expect(buildInvocation({ id: "c", name: "Claude Code", preset: "claude-code" }, prompt, "approve", "linux").args.at(-1)).toBe("acceptEdits");
    expect(buildInvocation({ id: "c", name: "Claude Code", preset: "claude-code" }, prompt, "full", "linux").args.at(-1)).toBe("bypassPermissions");
  });

  it("maps approval modes onto Codex sandboxes", () => {
    expect(buildInvocation({ id: "x", name: "Codex", preset: "codex" }, prompt, "ask", "linux").args).toEqual(["exec", "--sandbox", "read-only", prompt]);
    expect(buildInvocation({ id: "x", name: "Codex", preset: "codex" }, prompt, "approve", "linux").args).toContain("workspace-write");
  });

  it("never puts the prompt on a Windows command line", () => {
    const claude = buildInvocation({ id: "c", name: "Claude Code", preset: "claude-code" }, prompt, "ask", "win32");
    expect(claude.args).not.toContain(prompt);
    expect(claude.stdin).toBe(prompt);
    const custom = buildInvocation({ id: "a", name: "Aider", command: "aider", args: ["--message", "{prompt}", "--yes"] }, prompt, "ask", "win32");
    expect(custom).toEqual({ command: "aider", args: ["--yes"], output: "text", stdin: prompt });
  });

  it("fills {prompt} in custom commands, or appends it", () => {
    expect(buildInvocation({ id: "a", name: "Aider", command: "aider", args: ["--message", "{prompt}"] }, prompt, "ask", "linux").args).toEqual(["--message", prompt]);
    expect(buildInvocation({ id: "g", name: "Gemini", command: "gemini", args: ["-p"] }, prompt, "ask", "linux").args).toEqual(["-p", prompt]);
    expect(() => buildInvocation({ id: "b", name: "Broken" }, prompt)).toThrow("needs a command");
  });
});

describe("ClaudeStreamParser", () => {
  it("reports tool use and returns the final result", () => {
    const updates: unknown[] = [];
    const parser = new ClaudeStreamParser(update => updates.push(update));
    parser.line(JSON.stringify({ type: "system", subtype: "init" }));
    parser.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the login code." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth/login.py" } }] } }));
    parser.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "def login(): ..." }] }] } }));
    parser.line("not json");
    parser.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Added the null check." }));
    expect(updates).toEqual([
      { kind: "message", text: "Reading the login code." },
      { kind: "tool-start", id: "t1", toolName: "Read", path: "src/auth/login.py" },
      { kind: "tool-end", id: "t1", toolName: "Read", path: "src/auth/login.py", text: "def login(): ...", failed: false }
    ]);
    expect(parser.finalText()).toBe("Added the null check.");
    expect(parser.error).toBeUndefined();
  });

  it("surfaces CLI errors", () => {
    const parser = new ClaudeStreamParser();
    parser.line(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    expect(parser.error).toBe("error_max_turns");
  });
});
