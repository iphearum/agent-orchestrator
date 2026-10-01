import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execAsync = promisify(exec);

/** Available only in explicit Full access mode; commands start in the open workspace directory. */
export async function runWorkspaceCommand(command: string): Promise<string> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) throw new Error("Open a workspace folder before running shell commands.");
  try {
    const result = await execAsync(command, { cwd, timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true });
    return JSON.stringify({ exitCode: 0, stdout: result.stdout.slice(0, 200_000), stderr: result.stderr.slice(0, 200_000) });
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return JSON.stringify({ exitCode: failure.code ?? 1, stdout: failure.stdout?.slice(0, 200_000) || "", stderr: failure.stderr?.slice(0, 200_000) || failure.message });
  }
}
