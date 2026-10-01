import { describe, expect, it } from "bun:test";
import { isTestCommand, parseTestOutput } from "../testReport";

describe("parseTestOutput", () => {
  it("reads pytest verbose output", () => {
    const report = parseTestOutput("pytest -v", [
      "tests/test_auth.py::test_login_success PASSED [ 50%]",
      "tests/test_auth.py::test_login_locked FAILED [100%]",
      "==================== 1 failed, 1 passed in 2.40s ===================="
    ].join("\n"));
    expect(report).toMatchObject({ passed: 1, failed: 1, durationS: 2.4 });
    expect(report?.cases).toEqual([
      { name: "test_login_success", status: "passed" },
      { name: "test_login_locked", status: "failed" }
    ]);
  });

  it("reads bun test output", () => {
    const report = parseTestOutput("bun test", ["(pass) auth > logs in [0.30ms]", "(fail) auth > rejects [1.20ms]", " 1 pass", " 1 fail", "Ran 2 tests across 1 file. [15.00ms]"].join("\n"));
    expect(report).toMatchObject({ passed: 1, failed: 1, durationS: 0.015 });
    expect(report?.cases[0]).toEqual({ name: "auth > logs in", status: "passed", durationS: 0.0003 });
  });

  it("reads jest output without confusing it with bun's format", () => {
    const report = parseTestOutput("npx jest", ["✓ logs in (3 ms)", "✕ rejects (12 ms)", "Tests:       1 failed, 1 passed, 2 total", "Time:        2.4 s"].join("\n"));
    expect(report).toMatchObject({ passed: 1, failed: 1, durationS: 2.4 });
    expect(report?.cases.map(c => c.name)).toEqual(["logs in", "rejects"]);
  });

  it("reads go test output", () => {
    const report = parseTestOutput("go test ./...", ["--- PASS: TestLogin (0.01s)", "--- FAIL: TestLogout (0.20s)"].join("\n"));
    expect(report).toMatchObject({ passed: 1, failed: 1 });
  });

  it("returns undefined for output that is not a test report", () => {
    expect(parseTestOutput("npm test", "npm ERR! missing script: test")).toBeUndefined();
  });

  it("recognises test commands", () => {
    expect(isTestCommand("pytest -q tests/auth")).toBe(true);
    expect(isTestCommand("bun test")).toBe(true);
    expect(isTestCommand("git status")).toBe(false);
  });
});
