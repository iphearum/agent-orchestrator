import { describe, expect, it } from "bun:test";
import { resolveReasoning } from "../reasoning";

const HARD = "Why does this fail?\n```\nTypeError: x is undefined\n```\nShould we refactor it?";

describe("thinking mode", () => {
  it("Auto thinks only when the message looks hard and turns reasoning off otherwise", () => {
    expect(resolveReasoning("Hello", {})).toEqual({ thinking: false, reasoningEffort: "none" });
    expect(resolveReasoning("How should we design chat history storage?", { thinking: "auto" })).toEqual({ thinking: true, reasoningEffort: "medium", estimated: "medium" });
    expect(resolveReasoning(HARD, { thinking: "auto" })).toEqual({ thinking: true, reasoningEffort: "high", estimated: "high" });
  });

  it("On always thinks, at least at medium effort", () => {
    expect(resolveReasoning("Hello", { thinking: "on" })).toEqual({ thinking: true, reasoningEffort: "medium", estimated: "medium" });
    expect(resolveReasoning(HARD, { thinking: "on" }).reasoningEffort).toBe("high");
  });

  it("Off turns a thinking model's reasoning off", () => {
    expect(resolveReasoning(HARD, { thinking: "off" })).toEqual({ thinking: false, reasoningEffort: "none" });
  });

  it("a manual effort always wins and is never reported as estimated", () => {
    expect(resolveReasoning(HARD, { thinking: "auto", reasoningEffort: "low" })).toEqual({ thinking: false, reasoningEffort: "low" });
    expect(resolveReasoning("Hello", { thinking: "auto", reasoningEffort: "high" })).toEqual({ thinking: true, reasoningEffort: "high" });
    expect(resolveReasoning("Hello", { thinking: "off", reasoningEffort: "high" })).toEqual({ thinking: false, reasoningEffort: "high" });
  });
});
