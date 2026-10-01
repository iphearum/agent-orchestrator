import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CliAgentTransport } from "../cliAgentTransport";

const fakeCli = join(import.meta.dir, "fixtures", "fake-claude.js");

describe("CliAgentTransport", () => {
  it("runs the CLI in the workspace, streams tool progress and returns the final result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cli-ws-"));
    const transport = new CliAgentTransport(
      () => ({ id: "fake", name: "Fake Claude", command: process.execPath, args: [fakeCli, "{prompt}"], output: "claude-stream-json", timeoutMs: 20_000 }),
      () => workspace
    );
    const progress: unknown[] = [];
    const result = await transport.run({ id: "coder", name: "Coder", description: "", systemPrompt: "", skills: [], canDelegate: false, cliLinkId: "fake" },
      "Fix the login bug", { taskId: "t", rootTaskId: "t", depth: 0, onProgress: update => progress.push(update) });

    expect(result).toBe(`handled: Fix the login bug in ${basename(workspace)}`);
    expect(progress).toEqual([
      { kind: "tool-start", id: "t1", toolName: "Read", path: "src/auth/login.py" },
      { kind: "tool-end", id: "t1", toolName: "Read", path: "src/auth/login.py", text: "def login(): ...", failed: false }
    ]);
  });

  it("explains a missing CLI instead of failing silently", async () => {
    const transport = new CliAgentTransport(() => ({ id: "none", name: "Nope CLI", command: "definitely-not-installed-cli-xyz" }), () => tmpdir());
    const run = transport.run({ id: "coder", name: "Coder", description: "", systemPrompt: "", skills: [], canDelegate: false, cliLinkId: "none" }, "hi", { taskId: "t", rootTaskId: "t", depth: 0 });
    await expect(run).rejects.toThrow(/not found|exited with code|not recognized/);
  });
});
