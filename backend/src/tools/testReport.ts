import type { TestReportView } from "../shared/protocol";

const TEST_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|ava|tap|phpunit|rspec)\b/i;

export function isTestCommand(command: string) { return TEST_COMMAND.test(command); }

type Case = TestReportView["cases"][number];

const seconds = (value: string, unit: string) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return unit === "ms" ? n / 1000 : n;
};

/**
 * Best-effort summary of common test runner output (bun, pytest, jest/vitest, go).
 * Returns undefined when nothing recognisable is found, so the UI can show "no results"
 * instead of a misleading 0/0.
 */
export function parseTestOutput(command: string, output: string): TestReportView | undefined {
  const cases: Case[] = [];
  let passed: number | undefined;
  let failed: number | undefined;
  let durationS: number | undefined;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    // jest/vitest case: "✓ name (3 ms)" — checked before the bun form, whose duration is optional
    if ((m = line.match(/^([✓✔]|✕|×)\s+(.+?)\s+\((\d+(?:\.\d+)?)\s*(ms|s)\)$/))) {
      cases.push({ name: m[2], status: ["✓", "✔"].includes(m[1]) ? "passed" : "failed", durationS: seconds(m[3], m[4]) });
      continue;
    }
    // bun: "(pass) suite > name [0.30ms]" / "✓ name [0.30ms]"
    if ((m = line.match(/^(?:\((pass|fail)\)|([✓✔]|✗|✕|×))\s+(.+?)(?:\s+\[([\d.]+)(ms|s)\])?$/))) {
      const ok = m[1] ? m[1] === "pass" : ["✓", "✔"].includes(m[2]);
      cases.push({ name: m[3], status: ok ? "passed" : "failed", durationS: m[4] ? seconds(m[4], m[5]) : undefined });
      continue;
    }
    // pytest -v: "tests/test_auth.py::test_login PASSED [ 20%]"
    if ((m = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/))) {
      cases.push({ name: m[1].split("::").pop() || m[1], status: m[2] === "PASSED" ? "passed" : "failed" });
      continue;
    }
    // go: "--- PASS: TestLogin (0.00s)"
    if ((m = line.match(/^--- (PASS|FAIL): (\S+) \(([\d.]+)s\)/))) {
      cases.push({ name: m[2], status: m[1] === "PASS" ? "passed" : "failed", durationS: Number(m[3]) });
      continue;
    }
    // bun totals: " 12 pass" / " 0 fail"
    if ((m = line.match(/^(\d+) pass$/))) passed = Number(m[1]);
    else if ((m = line.match(/^(\d+) fail$/))) failed = Number(m[1]);
    // bun: "Ran 12 tests across 3 files. [2.40s]"
    if ((m = line.match(/^Ran \d+ tests? across .*\[([\d.]+)(ms|s)\]/))) durationS = seconds(m[1], m[2]);
    // pytest: "==== 12 passed, 1 failed in 2.40s ===="
    if ((m = line.match(/=+ (.*?) in ([\d.]+)s/)) && /passed|failed/.test(m[1])) {
      passed = Number(m[1].match(/(\d+) passed/)?.[1] ?? 0);
      failed = Number(m[1].match(/(\d+) (?:failed|error)/)?.[1] ?? 0);
      durationS = Number(m[2]);
    }
    // jest: "Tests:       1 failed, 12 passed, 13 total" · vitest: "Tests  12 passed (12)"
    if ((m = line.match(/^Tests:?\s+(.*)$/)) && /passed|failed/.test(m[1])) {
      passed = Number(m[1].match(/(\d+) passed/)?.[1] ?? 0);
      failed = Number(m[1].match(/(\d+) failed/)?.[1] ?? 0);
    }
    // jest/vitest: "Time: 2.4 s" / "Duration  2.40s"
    if ((m = line.match(/^(?:Time|Duration):?\s+([\d.]+)\s*(ms|s)\b/))) durationS = seconds(m[1], m[2]);
  }

  if (passed === undefined && failed === undefined && !cases.length) return undefined;
  return {
    command,
    passed: passed ?? cases.filter(c => c.status === "passed").length,
    failed: failed ?? cases.filter(c => c.status === "failed").length,
    durationS,
    cases
  };
}
