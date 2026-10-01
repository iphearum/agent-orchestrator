import * as vscode from "vscode";
import { formatOverview, formatSearch, normalizeWorkspaceArgs, outline, readWindow, type SearchMatch } from "./fileView";

const EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/coverage/**,**/*.lock,**/*.min.js,**/*.map}";

/** Workspace-scoped file capabilities for local agents. Paths cannot escape the open folder. */
export class WorkspaceTools {
  /** Never throws: a failure comes back as `{"error": …}` for the agent to read, so one bad call can't end its run. */
  async execute(name: string, rawArgs: Record<string, unknown>): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return JSON.stringify({ error: "Open a workspace folder before using workspace file tools." });
    const args = normalizeWorkspaceArgs(name, rawArgs);
    const path = String(args.path ?? "");
    try {
      switch (name) {
        case "search_workspace":
          if (!String(args.query ?? "").trim()) return await this.overview(folder, "search_workspace got no query, so here is the workspace layout instead.");
          return await this.search(folder, String(args.query), String(args.glob || "**/*"));
        case "read_file":
          if (!path) return await this.overview(folder, "read_file got no path, so here is the workspace layout instead.");
          return await this.read(folder, path, optionalLine(args.start_line), optionalLine(args.end_line));
        case "file_outline":
          if (!path) return await this.overview(folder, "file_outline got no path, so here is the workspace layout instead.");
          return await this.outline(folder, path);
        case "write_file": return await this.write(folder, path, String(args.content ?? ""));
        default: return JSON.stringify({ error: `Unknown workspace tool '${name}'.` });
      }
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return await this.notFound(folder, path);
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private resolve(folder: vscode.WorkspaceFolder, relativePath: string) {
    const root = folder.uri.fsPath.replace(/\\/g, "/").replace(/\/$/, "");
    // Models sometimes pass the absolute path they saw in a result; accept it when it's inside the workspace.
    const normalized = relativePath.replace(/\\/g, "/");
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) relativePath = normalized.slice(root.length + 1);
    if (!relativePath.trim() || relativePath.startsWith("/") || relativePath.startsWith("\\") || /^[a-z]:/i.test(relativePath)) throw new Error("Use a non-empty workspace-relative path.");
    const segments = relativePath.split(/[\\/]+/).filter(segment => segment && segment !== ".");
    if (!segments.length || segments.includes("..")) throw new Error("The requested path is outside the workspace.");
    return { segments, uri: vscode.Uri.joinPath(folder.uri, ...segments), relative: segments.join("/") };
  }

  private async listFiles(folder: vscode.WorkspaceFolder, glob = "**/*", max = 400) {
    return vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob || "**/*"), EXCLUDE, max);
  }

  private async overview(folder: vscode.WorkspaceFolder, reason: string) {
    const files = await this.listFiles(folder, "**/*", 2000);
    return formatOverview(files.map(uri => vscode.workspace.asRelativePath(uri, false)), reason);
  }

  /** A path that doesn't exist: suggest files with the same name instead of a bare error. */
  private async notFound(folder: vscode.WorkspaceFolder, relativePath: string) {
    const base = relativePath.split(/[\\/]/).pop() ?? "";
    const escaped = base.replace(/[[\]{}*?]/g, "");
    const similar = escaped ? await this.listFiles(folder, `**/${escaped}`, 5).then(uris => uris.map(uri => vscode.workspace.asRelativePath(uri, false)), () => []) : [];
    return JSON.stringify({ error: `File not found: ${relativePath}.${similar.length ? ` Files with that name: ${similar.join(", ")}.` : " Use search_workspace to find the right path."}` });
  }

  /** Grep-style: matching lines with line numbers, at most a few per file so one file cannot crowd out the rest. */
  private async search(folder: vscode.WorkspaceFolder, query: string, glob: string) {
    const files = await this.listFiles(folder, glob);
    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];
    let scanned = 0, truncated = false;
    for (const uri of files) {
      if (matches.length >= 60) { truncated = true; break; }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 512_000 || bytes.includes(0)) continue;
        scanned++;
        const lines = new TextDecoder("utf-8").decode(bytes).split(/\r?\n/);
        let inFile = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          if (inFile++ >= 6 || matches.length >= 60) { truncated = true; break; }
          matches.push({ path: vscode.workspace.asRelativePath(uri), line: i + 1, text: lines[i] });
        }
      } catch { /* Skip unreadable files. */ }
    }
    return formatSearch(query, matches, scanned, truncated);
  }

  /** A numbered window of the file (about 160 lines); agents page through with start_line/end_line. */
  private async read(folder: vscode.WorkspaceFolder, relativePath: string, start?: number, end?: number) {
    const target = this.resolve(folder, relativePath);
    const bytes = await vscode.workspace.fs.readFile(target.uri);
    if (bytes.byteLength > 5_000_000) throw new Error("File is larger than 5 MB. Use search_workspace to find the relevant lines.");
    return readWindow(target.relative, new TextDecoder("utf-8").decode(bytes), start, end);
  }

  private async outline(folder: vscode.WorkspaceFolder, relativePath: string) {
    const target = this.resolve(folder, relativePath);
    const bytes = await vscode.workspace.fs.readFile(target.uri);
    if (bytes.byteLength > 5_000_000) throw new Error("File is larger than 5 MB.");
    return outline(target.relative, new TextDecoder("utf-8").decode(bytes));
  }

  private async write(folder: vscode.WorkspaceFolder, relativePath: string, content: string) {
    const target = this.resolve(folder, relativePath);
    if (target.segments.length > 1) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...target.segments.slice(0, -1)));
    await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(content));
    return JSON.stringify({ ok: true, path: target.relative, bytesWritten: Buffer.byteLength(content, "utf8") });
  }
}

function optionalLine(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}
