import { describe, expect, it } from "bun:test";
import { RuntimeActivity } from "../activity";
import type { RunEvent } from "../orchestrator";

const event = (type: RunEvent["type"], agentId: string, extra: Partial<RunEvent> = {}): RunEvent => ({ type, agentId, text: "", rootTaskId: "root-1", ...extra });

describe("RuntimeActivity", () => {
  it("tracks a delegated run from start to finish", () => {
    const activity = new RuntimeActivity();
    activity.handle(event("start", "lead"));
    expect(activity.agentState("lead")).toBe("thinking");
    expect(activity.isRootRunning("root-1")).toBe(true);

    activity.handle(event("delegate", "lead"));
    activity.handle(event("start", "coder"));
    activity.handle(event("tool", "coder", { phase: "start", text: "Using read_file" }));
    expect(activity.agentState("lead")).toBe("delegating");
    expect(activity.agentState("coder")).toBe("running");
    expect(activity.agentsRunning()).toBe(2);

    activity.handle(event("result", "coder"));
    expect(activity.agentState("coder")).toBe("idle");
    expect(activity.isRootRunning("root-1")).toBe(true);

    activity.handle(event("result", "lead"));
    expect(activity.isRootRunning("root-1")).toBe(false);
    expect(activity.agentsRunning()).toBe(0);
  });

  it("shows approval waits and failures", () => {
    const activity = new RuntimeActivity();
    activity.handle(event("start", "coder"));
    activity.handle(event("tool", "coder", { phase: "start", text: "Waiting for approval: write_file" }));
    expect(activity.agentState("coder")).toBe("waiting");
    activity.handle(event("error", "coder"));
    expect(activity.agentState("coder")).toBe("failed");
    expect(activity.isRootRunning("root-1")).toBe(false);
  });

  it("clears a run whose events stopped early", () => {
    const activity = new RuntimeActivity();
    activity.handle(event("start", "lead"));
    activity.finishRoot("root-1");
    expect(activity.runningRootIds()).toEqual([]);
    expect(activity.agentState("lead")).toBe("idle");
  });

  it("ignores events without a root task", () => {
    const activity = new RuntimeActivity();
    activity.handle({ type: "start", agentId: "lead", text: "" });
    expect(activity.runningRootIds()).toEqual([]);
  });
});
