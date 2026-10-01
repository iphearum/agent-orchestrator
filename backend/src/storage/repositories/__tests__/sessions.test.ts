import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../../persistence/database";
import { SessionRepository } from "../sessions";

let dir: string;
let db: AgentDatabase;
let sessions: SessionRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-"));
  db = new AgentDatabase(dir);
  sessions = new SessionRepository(db.connection);
});

afterEach(() => {
  db.connection.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup */ }
});

describe("reply traces", () => {
  const trace = { version: 1 as const, durationMs: 12_345.6, steps: [
    { type: "tool" as const, agentId: "coder", toolName: "read_file", toolCallId: "c1", phase: "complete", path: "src/a.ts", text: "x".repeat(5000) }
  ], thinking: [{ agentId: "coder", text: "Check the form first." }] };

  it("attaches the record to the answer written by this run and returns it with the transcript", () => {
    sessions.ensure("s1", "Fix it", "coder");
    db.addConversationMessage("m1", "s1", null, "user", "first");
    db.addConversationMessage("m2", "s1", "coder", "result", "old answer");
    const start = sessions.lastMessageRowid("s1");
    db.addConversationMessage("m3", "s1", null, "user", "second");
    db.addConversationMessage("m4", "s1", "coder", "result", "new answer");

    expect(sessions.saveReplyTrace("s1", start, trace)).toBe(true);
    const [, oldAnswer, , newAnswer] = sessions.messages("s1");
    expect(oldAnswer.trace).toBeUndefined();
    expect(newAnswer.trace).toMatchObject({ version: 1, durationMs: 12346, thinking: [{ agentId: "coder", text: "Check the form first." }] });
    // Tool output is never stored with the record, only a short label.
    expect(newAnswer.trace!.steps[0].text).toHaveLength(300);
  });

  it("does not attach a record to an older answer when the run wrote none", () => {
    sessions.ensure("s1", "Fix it", "coder");
    db.addConversationMessage("m1", "s1", "coder", "result", "old answer");
    const start = sessions.lastMessageRowid("s1");
    expect(sessions.saveReplyTrace("s1", start, trace)).toBe(false);
    expect(sessions.messages("s1")[0].trace).toBeUndefined();
  });

  it("keeps failed replies for display without putting them in the agent's context", () => {
    sessions.ensure("s1", "Fix it", "coder");
    db.addConversationMessage("m1", "s1", null, "user", "do it");
    sessions.addFailedReply("f1", "s1", "coder", "Model unreachable", trace);
    const reply = sessions.messages("s1")[1];
    expect(reply).toMatchObject({ role: "result", text: "Model unreachable", trace: { failed: true } });
    expect(db.recentMessages("s1").join("\n")).not.toContain("Model unreachable");
  });
});

describe("SessionRepository", () => {
  it("continues an existing session instead of creating another", () => {
    sessions.ensure("s1", "Fix the login bug", "coder");
    db.addConversationMessage("m1", "s1", null, "user", "Fix the login bug");
    db.addConversationMessage("m2", "s1", "coder", "assistant", "Looking at login.py…");
    db.addConversationMessage("m3", "s1", "coder", "result", "Added the null check.");
    // A follow-up in the same session, as the chat window sends it.
    sessions.ensure("s1", "continue", "lead");
    db.addConversationMessage("m4", "s1", null, "user", "continue");

    const [only] = sessions.list({ archived: false });
    expect(sessions.list({ archived: false })).toHaveLength(1);
    expect(only).toMatchObject({ id: "s1", title: "Fix the login bug", agentId: "coder", turns: 2, preview: "continue" });
    // Intermediate agent messages are not part of the chat transcript.
    expect(sessions.messages("s1").map(m => [m.role, m.text])).toEqual([
      ["user", "Fix the login bug"], ["result", "Added the null check."], ["user", "continue"]
    ]);
  });

  it("archives, restores and renames sessions", () => {
    sessions.ensure("s1", "First", "coder");
    sessions.ensure("s2", "Second", "researcher");
    sessions.setArchived("s1", true);
    expect(sessions.list({ archived: false }).map(s => s.id)).toEqual(["s2"]);
    expect(sessions.list({ archived: true })).toEqual([expect.objectContaining({ id: "s1", archived: true })]);

    sessions.setArchived("s1", false);
    sessions.rename("s1", "  Login   bug  ");
    expect(sessions.get("s1")).toMatchObject({ title: "Login bug", archived: false });
  });
});
