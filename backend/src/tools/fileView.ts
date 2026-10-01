// Token-frugal views of workspace files for agents: numbered line windows, structural outlines,
// and grep-style search output. Pure functions so both the VS Code tools and tests can use them.

export const READ_LIMITS = { maxLines: 160, maxChars: 8_000, maxLineChars: 400 };

/**
 * A window of a file with line numbers, sized so it reaches the model intact.
 * `start`/`end` are 1-based and inclusive; out-of-range values are clamped.
 */
export function readWindow(path: string, content: string, start?: number, end?: number, limits = READ_LIMITS): string {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  if (!total) return `${path} is empty.`;
  const from = clamp(Math.floor(start ?? 1), 1, total);
  const requestedEnd = end === undefined ? total : clamp(Math.floor(end), from, total);
  const width = String(Math.min(requestedEnd, from + limits.maxLines - 1)).length;
  const out: string[] = [];
  let chars = 0;
  let last = from - 1;
  for (let n = from; n <= requestedEnd && n < from + limits.maxLines; n++) {
    let text = lines[n - 1];
    if (text.length > limits.maxLineChars) text = `${text.slice(0, limits.maxLineChars)}… [line cut at ${limits.maxLineChars} chars]`;
    const row = `${String(n).padStart(width)}| ${text}`;
    if (chars + row.length > limits.maxChars && out.length) break;
    out.push(row);
    chars += row.length + 1;
    last = n;
  }
  const header = `${path} · lines ${from}-${last} of ${total}`;
  const more = last < total
    ? `\n[Showing lines ${from}-${last} of ${total}. Continue with read_file start_line=${last + 1}, or use file_outline / search_workspace to jump to the part you need.]`
    : "";
  return `${header}\n${out.join("\n")}${more}`;
}

type OutlineRule = { pattern: RegExp; label: (m: RegExpMatchArray) => string; indent?: (m: RegExpMatchArray) => number };

const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor"]);
const TS_RULES: OutlineRule[] = [
  { pattern: /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, label: m => `${m[5].replace("*", "")} ${m[6]}` },
  { pattern: /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*(:[^=]+)?=\s*(async\s*)?(\(|function|class|\{|\[|new\s)/, label: m => `${m[2]} ${m[3]}` },
  { pattern: /^\s{2,4}(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*(constructor|[A-Za-z_$][\w$]*)\s*(<[^>]*>)?\(/, label: m => `${m[1]}()`, indent: () => 1 }
];
const PY_RULES: OutlineRule[] = [
  { pattern: /^(\s*)(async\s+)?def\s+(\w+)/, label: m => `def ${m[3]}()`, indent: m => Math.min(3, Math.floor(m[1].length / 4)) },
  { pattern: /^(\s*)class\s+(\w+)/, label: m => `class ${m[2]}`, indent: m => Math.min(3, Math.floor(m[1].length / 4)) }
];
const GO_RULES: OutlineRule[] = [
  { pattern: /^func\s+(\([^)]*\)\s*)?(\w+)/, label: m => `func ${m[2]}` },
  { pattern: /^type\s+(\w+)\s+(\w+)/, label: m => `type ${m[1]} ${m[2]}` }
];
const SQL_RULES: OutlineRule[] = [
  { pattern: /^\s*CREATE\s+(TABLE|INDEX|UNIQUE INDEX|VIEW|TRIGGER)\s+(IF NOT EXISTS\s+)?([\w."]+)/i, label: m => `${m[1].toUpperCase()} ${m[3]}` }
];
const MD_RULES: OutlineRule[] = [
  { pattern: /^(#{1,6})\s+(.+?)\s*#*$/, label: m => m[2], indent: m => m[1].length - 1 }
];
const KEY_RULES: OutlineRule[] = [
  { pattern: /^([A-Za-z_][\w.-]*)\s*[:=]/, label: m => m[1] },
  { pattern: /^\[([^\]]+)\]/, label: m => `[${m[1]}]` }
];

function rulesFor(path: string): OutlineRule[] | "json" | undefined {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return TS_RULES;
  if (ext === "py") return PY_RULES;
  if (ext === "go") return GO_RULES;
  if (ext === "sql") return SQL_RULES;
  if (["md", "markdown", "mdx"].includes(ext)) return MD_RULES;
  if (ext === "json") return "json";
  if (["yml", "yaml", "toml", "ini", "env", "properties"].includes(ext)) return KEY_RULES;
  return undefined;
}

/** The main points of a file (declarations, headings, keys) with line numbers, without its body. */
export function outline(path: string, content: string, maxEntries = 120): string {
  const lines = content.split(/\r?\n/);
  const size = `${lines.length} lines, ${(content.length / 1024).toFixed(1)} KB`;
  const rules = rulesFor(path);
  const entries: string[] = [];
  if (rules === "json") {
    try {
      const value = JSON.parse(content);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value).slice(0, maxEntries)) {
          const line = lines.findIndex(text => text.includes(`"${key}"`)) + 1;
          const kind = Array.isArray(child) ? `array(${child.length})` : child && typeof child === "object" ? `object(${Object.keys(child).length} keys)` : typeof child;
          entries.push(`${String(line || "?").padStart(5)}  ${key}: ${kind}`);
        }
      }
    } catch { /* fall through to "no outline" */ }
  } else if (rules) {
    let inTemplate = false;
    for (let i = 0; i < lines.length && entries.length < maxEntries; i++) {
      const text = lines[i];
      // Skip the contents of long template strings/markup so embedded code isn't mistaken for declarations.
      if ((text.match(/`/g) ?? []).length % 2 === 1) inTemplate = !inTemplate;
      if (inTemplate) continue;
      for (const rule of rules) {
        const m = text.match(rule.pattern);
        if (!m) continue;
        const label = rule.label(m);
        if (rule === TS_RULES[2] && NOT_METHODS.has(m[1]) && m[1] !== "constructor") break;
        entries.push(`${String(i + 1).padStart(5)}  ${"  ".repeat(rule.indent?.(m) ?? 0)}${label}`);
        break;
      }
    }
  }
  if (!entries.length) return `${path} · ${size}\nNo outline available for this file type. Use read_file with start_line/end_line, or search_workspace.`;
  const more = entries.length >= maxEntries ? `\n[Outline cut at ${maxEntries} entries. Use search_workspace to find a specific name.]` : "";
  return `${path} · ${size}\n${entries.join("\n")}${more}\n[Read a section with read_file start_line/end_line.]`;
}

export interface SearchMatch { path: string; line: number; text: string }

/** Directories are useful navigation targets, but they cannot be passed to a file reader. */
export function formatDirectory(path: string, entries: Array<{ name: string; directory: boolean }>, maxEntries = 80): string {
  const shown = [...entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).slice(0, maxEntries);
  const lines = shown.map(entry => `${path.replace(/\/$/, "")}/${entry.name}${entry.directory ? "/" : ""}`);
  return `${path}/ · directory (${entries.length} entries)\n${lines.join("\n") || "(empty)"}${entries.length > shown.length ? "\n…" : ""}\n[Use read_file or file_outline with a file path above; open a subdirectory with file_outline.]`;
}

/** Suggest actual workspace paths after a model guesses a basename or directory. */
export function suggestWorkspacePaths(paths: string[], requested: string, max = 6): string[] {
  const name = requested.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop()?.toLowerCase() ?? "";
  if (!name) return [];
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const exactFiles = paths.filter(path => path.split("/").pop()?.toLowerCase() === name);
  const exactDirectories = [...directories].filter(path => path.split("/").pop()?.toLowerCase() === name).map(path => `${path}/`);
  const stem = name.replace(/\.[^.]+$/, "");
  const partial = !exactFiles.length && !exactDirectories.length && stem.length >= 3
    ? paths.filter(path => path.split("/").pop()?.toLowerCase().includes(stem))
    : [];
  return [...exactFiles, ...exactDirectories, ...partial].slice(0, max);
}

/** Grep-style output grouped by file; long lines are trimmed around the match. */
export function formatSearch(query: string, matches: SearchMatch[], scannedFiles: number, truncated: boolean): string {
  if (!matches.length) return `No matches for "${query}" in ${scannedFiles} files. Try a shorter or different term.`;
  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) byFile.set(match.path, [...(byFile.get(match.path) ?? []), match]);
  const needle = query.toLowerCase();
  const blocks = [...byFile].map(([path, found]) => `${path}\n${found.map(match => match.line === 0 ? "    (path match)" : `${String(match.line).padStart(5)}: ${around(match.text, needle)}`).join("\n")}`);
  const summary = `${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}" in ${byFile.size} file${byFile.size === 1 ? "" : "s"} (${scannedFiles} scanned)${truncated ? "; more exist, narrow the query or glob" : ""}.`;
  return `${summary}\n${blocks.join("\n")}\n[Open a hit with read_file start_line near the line number.]`;
}

// Small models often name arguments after what they mean ("filename", "pattern") instead of the schema's name.
const ARG_ALIASES: Record<string, string[]> = {
  path: ["path", "file_path", "filepath", "file", "filename", "file_name", "relative_path", "target"],
  query: ["query", "q", "search", "search_query", "search_term", "term", "pattern", "keyword", "keywords", "text", "symbol", "regex"],
  glob: ["glob", "include", "file_pattern"],
  start_line: ["start_line", "start", "from_line", "line"],
  end_line: ["end_line", "end", "to_line"]
};
const TOOL_ARGS: Record<string, string[]> = {
  search_workspace: ["query", "glob"],
  read_file: ["path", "start_line", "end_line"],
  file_outline: ["path"],
  write_file: ["path"]
};

/**
 * Map misnamed arguments onto the schema's names, e.g. `{filename: "README.md"}` → `{path: "README.md"}`. A search
 * with no query but a file name searches for that name. Blank strings count as missing. Other arguments pass through.
 */
export function normalizeWorkspaceArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const present = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
  for (const key of TOOL_ARGS[tool] ?? []) {
    if (present(out[key])) continue;
    const alias = ARG_ALIASES[key].find(name => present(args[name]));
    if (alias) out[key] = args[alias];
  }
  if (tool === "search_workspace" && !present(out.query)) {
    const fileName = ARG_ALIASES.path.map(name => args[name]).find(present);
    if (fileName) out.query = fileName;
  }
  for (const key of ["path", "query"]) if (typeof out[key] === "string") out[key] = (out[key] as string).trim().replace(/^\.[\\/]+/, "");
  return out;
}

/**
 * A compact map of the workspace: top-level files, then each folder with its file count and first entries.
 * Given in place of an error when a search has no query or a read has no path, so the agent gets real paths to use.
 */
export function formatOverview(paths: string[], reason: string, maxChars = 3000): string {
  const topFiles: string[] = [];
  const folders = new Map<string, { count: number; children: Set<string> }>();
  for (const path of [...paths].sort()) {
    const [first, second, ...rest] = path.split("/");
    if (second === undefined) { topFiles.push(first); continue; }
    const folder = folders.get(first) ?? { count: 0, children: new Set<string>() };
    folder.count++;
    folder.children.add(rest.length ? `${second}/` : second);
    folders.set(first, folder);
  }
  const lines = [
    ...topFiles,
    ...[...folders].map(([name, { count, children }]) => {
      const shown = [...children].slice(0, 8);
      return `${name}/ (${count} file${count === 1 ? "" : "s"}): ${shown.join(", ")}${children.size > shown.length ? ", …" : ""}`;
    })
  ];
  const header = `${reason} Workspace layout (${paths.length} files):`;
  let text = header;
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) { text += "\n…"; break; }
    text += `\n${line}`;
  }
  return `${text}\n[Next: read_file with one of these paths, or search_workspace with a specific term.]`;
}

function around(text: string, needle: string, radius = 90) {
  const clean = text.trim();
  if (clean.length <= radius * 2) return clean;
  const at = Math.max(0, clean.toLowerCase().indexOf(needle));
  const from = Math.max(0, at - radius);
  return `${from > 0 ? "…" : ""}${clean.slice(from, at + needle.length + radius)}${at + needle.length + radius < clean.length ? "…" : ""}`;
}

function clamp(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
