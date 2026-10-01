import { describe, expect, it } from "bun:test";
import { formatOverview, formatSearch, normalizeWorkspaceArgs, outline, readWindow } from "../fileView";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("readWindow", () => {
  it("returns a numbered window and says how to continue", () => {
    const text = readWindow("a.ts", numbered(500));
    expect(text.split("\n")[0]).toBe("a.ts · lines 1-160 of 500");
    expect(text).toContain("  1| line 1");
    expect(text).toContain("Continue with read_file start_line=161");
  });

  it("reads an exact range and stops at the file end", () => {
    const text = readWindow("a.ts", numbered(50), 45, 90);
    expect(text.split("\n")[0]).toBe("a.ts · lines 45-50 of 50");
    expect(text).not.toContain("Continue with");
  });

  it("keeps the result under the character budget and trims giant lines", () => {
    const text = readWindow("min.js", `${"x".repeat(5000)}\n${"y".repeat(5000)}\n${"z".repeat(5000)}`);
    expect(text.length).toBeLessThan(9_000);
    expect(text).toContain("[line cut at 400 chars]");
  });
});

describe("outline", () => {
  it("lists TypeScript declarations and methods with line numbers", () => {
    const source = [
      'import * as fs from "fs";',
      "export class AgentDatabase {",
      "  constructor(dir: string) {",
      "    if (dir) {}",
      "  }",
      "  listAgents(): string[] { return []; }",
      "}",
      "export async function openDb() {}",
      "export const helper = () => 1;",
      "const html = `",
      "function notReal() {}",
      "`;"
    ].join("\n");
    const text = outline("db.ts", source);
    expect(text).toContain("2  class AgentDatabase");
    expect(text).toContain("3    constructor()");
    expect(text).toContain("6    listAgents()");
    expect(text).toContain("8  function openDb");
    expect(text).toContain("9  const helper");
    expect(text).not.toContain("if()");
    expect(text).not.toContain("notReal");
  });

  it("outlines markdown headings, python and json", () => {
    expect(outline("README.md", "# Title\ntext\n## Install\n### Linux")).toContain("4      Linux");
    expect(outline("app.py", "class User:\n    def login(self):\n        pass")).toContain("2    def login()");
    expect(outline("package.json", '{\n  "name": "x",\n  "scripts": { "a": "b" }\n}')).toContain("3  scripts: object(1 keys)");
  });

  it("says so when it cannot outline a file", () => {
    expect(outline("notes.txt", "hello")).toContain("No outline available");
  });
});

describe("formatSearch", () => {
  it("groups hits by file with line numbers", () => {
    const text = formatSearch("user", [
      { path: "src/login.py", line: 8, text: "    user = await db.get_user(email)" },
      { path: "src/login.py", line: 9, text: "    if not user:" },
      { path: "tests/test_login.py", line: 3, text: "def test_user(): pass" }
    ], 12, false);
    expect(text.split("\n")[0]).toBe('3 matches for "user" in 2 files (12 scanned).');
    expect(text).toContain("src/login.py\n    8: user = await db.get_user(email)");
  });

  it("guides the agent when nothing matches", () => {
    expect(formatSearch("zzz", [], 40, false)).toContain("No matches");
  });
});

describe("normalizeWorkspaceArgs", () => {
  it("maps the argument names small models use onto the schema", () => {
    expect(normalizeWorkspaceArgs("read_file", { filename: "./README.md", start: 10 })).toMatchObject({ path: "README.md", start_line: 10 });
    expect(normalizeWorkspaceArgs("search_workspace", { pattern: " orchestrator " })).toMatchObject({ query: "orchestrator" });
    // A search given only a file name searches for that name.
    expect(normalizeWorkspaceArgs("search_workspace", { workspace: "The project", filename: "README.md" })).toMatchObject({ query: "README.md" });
  });

  it("keeps correct arguments and leaves a search with nothing usable blank", () => {
    expect(normalizeWorkspaceArgs("read_file", { path: "src/a.ts", filename: "b.ts" }).path).toBe("src/a.ts");
    expect(normalizeWorkspaceArgs("search_workspace", { query: "  ", q: "auth" }).query).toBe("auth");
    expect(normalizeWorkspaceArgs("search_workspace", { workspace: "The project", limit: "5" }).query).toBeUndefined();
  });
});

describe("formatOverview", () => {
  it("lists top-level files and each folder with its count and first entries", () => {
    const text = formatOverview(["README.md", "package.json", "src/a.ts", "src/b.ts", "src/core/c.ts", "docs/x.md"], "No query.");
    expect(text.split("\n")[0]).toBe("No query. Workspace layout (6 files):");
    expect(text).toContain("README.md\npackage.json");
    expect(text).toContain("src/ (3 files): a.ts, b.ts, core/");
    expect(text).toContain("docs/ (1 file): x.md");
    expect(text).toContain("read_file with one of these paths");
  });

  it("stays within its size budget", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `folder${i}/file.ts`);
    expect(formatOverview(paths, "No query.", 400).length).toBeLessThan(520);
  });
});
