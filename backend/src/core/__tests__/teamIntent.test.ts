import { describe, expect, it } from "bun:test";
import { fallbackTeamPlan, mayNeedTeam } from "../teamIntent";

describe("mayNeedTeam", () => {
  it("skips team questions for single-topic requests", () => {
    for (const message of ["Write me a documents for that.", "Give me project description", "hi", "Explain how the auth module stores sessions.", "Fix the login bug"]) {
      expect(mayNeedTeam(message)).toBe(false);
    }
  });

  it("asks for a team plan when the request spans several areas or parts", () => {
    expect(mayNeedTeam("Fix the login bug and write tests for it")).toBe(true);
    expect(mayNeedTeam("Please:\n- update the schema\n- add an endpoint")).toBe(true);
    expect(mayNeedTeam("Run these in parallel if you can")).toBe(true);
    expect(mayNeedTeam("x ".repeat(250))).toBe(true);
  });
});

describe("fallbackTeamPlan", () => {
  const all = ["lead", "coder", "researcher", "devops", "database", "documenter", "planner", "reviewer"];
  const shape = (message: string, agents = all) => fallbackTeamPlan(message, agents, "lead")?.tasks.map(task => `${task.agent_id}<${task.depends_on.join(",")}`);

  it("builds the design's flow: researcher, coder and devops in parallel, then the reviewer", () => {
    expect(shape("Fix authentication 500 error")).toEqual(["researcher<", "coder<", "devops<", "reviewer<researcher,coder,devops"]);
  });

  it("adds the specialists the request names and reviews any change", () => {
    expect(shape("Add a migration for the users schema")).toEqual(["devops<", "database<", "reviewer<devops,database"]);
    expect(shape("Implement the export endpoint")).toEqual(["coder<", "reviewer<coder"]);
    expect(shape("Update the README")).toEqual(["documenter<", "reviewer<documenter"]);
  });

  it("keeps questions, small talk and follow-ups with one agent", () => {
    expect(shape("Describe this project structure")).toBeUndefined();
    expect(shape("Explain how the task queue works")).toBeUndefined();
    expect(shape("Any solve?")).toBeUndefined();
    expect(shape("Hello")).toBeUndefined();
  });

  it("uses only agents that exist, and never the coordinator", () => {
    expect(shape("Fix authentication 500 error", ["lead", "coder"])).toBeUndefined();
    expect(shape("Fix authentication 500 error", ["lead", "coder", "reviewer"])).toEqual(["coder<", "reviewer<coder"]);
    expect(fallbackTeamPlan("Fix the bug", ["coder", "reviewer"], "coder")).toBeUndefined();
  });
});
