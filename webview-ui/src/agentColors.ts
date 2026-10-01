import type { CSSProperties } from "react";

// Agent hues map to theme chart/terminal colours so they adapt to light, dark and high-contrast themes.
const HUES: Record<string, string> = {
  supervisor: "--vscode-charts-purple",
  lead: "--vscode-charts-purple",
  coder: "--vscode-charts-green",
  researcher: "--vscode-charts-blue",
  planner: "--vscode-terminal-ansiCyan",
  database: "--vscode-terminal-ansiCyan",
  reviewer: "--vscode-charts-yellow",
  devops: "--vscode-charts-orange",
  documenter: "--vscode-terminal-ansiMagenta"
};
const FALLBACK = ["--vscode-charts-blue", "--vscode-charts-green", "--vscode-charts-purple", "--vscode-charts-orange", "--vscode-charts-yellow", "--vscode-terminal-ansiCyan", "--vscode-terminal-ansiMagenta", "--vscode-charts-red"];
const DARK_MODERN: Record<string, string> = {
  "--vscode-charts-purple": "#b180d7", "--vscode-charts-green": "#89d185", "--vscode-charts-blue": "#3794ff",
  "--vscode-terminal-ansiCyan": "#11a8cd", "--vscode-charts-yellow": "#cca700", "--vscode-charts-orange": "#d18616",
  "--vscode-terminal-ansiMagenta": "#bc3fbc", "--vscode-charts-red": "#f14c4c"
};

export function agentHueVar(key: string) {
  const known = HUES[key.toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK[hash % FALLBACK.length];
}

/** Sets --agent on an element; components read var(--agent) for borders, tints and text. */
export function agentStyle(key: string): CSSProperties {
  const variable = agentHueVar(key);
  return { ["--agent" as string]: `var(${variable}, ${DARK_MODERN[variable]})` } as CSSProperties;
}
