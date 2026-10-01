import type { ReactElement } from "react";

// Small inline icon set drawn to match VS Code's 16px line icons. No icon font is needed.
const PATHS: Record<string, ReactElement> = {
  overview: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  tasks: <><rect x="2.5" y="2" width="11" height="12" rx="1.5" /><path d="M5 5.5h6M5 8h6M5 10.5h4" /></>,
  agents: <><rect x="3" y="5" width="10" height="8" rx="2.5" /><path d="M8 5V2.5" /><circle cx="8" cy="2" r=".6" /><circle cx="6" cy="9" r=".9" /><circle cx="10" cy="9" r=".9" /></>,
  knowledge: <><circle cx="4" cy="4" r="1.8" /><circle cx="12" cy="5" r="1.8" /><circle cx="7" cy="12" r="1.8" /><path d="M5.6 4.3 10.2 4.8M4.8 5.6l1.5 4.7M11.2 6.6 8.3 10.7" /></>,
  memory: <><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /><rect x="6" y="6" width="4" height="4" rx=".5" /><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" /></>,
  tools: <path d="M9.5 2.2a3.2 3.2 0 0 0-3.9 4.1L2 9.9a1.4 1.4 0 0 0 2 2l3.6-3.6a3.2 3.2 0 0 0 4.1-3.9L9.8 6.3 8.5 5l1.9-1.9Z" />,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  add: <path d="M8 3v10M3 8h10" />,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  error: <><circle cx="8" cy="8" r="5.5" /><path d="m6 6 4 4M10 6l-4 4" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></>,
  file: <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" />,
  edit: <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />,
  terminal: <><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="m4 6 2.5 2L4 10M8 10.5h4" /></>,
  beaker: <path d="M6 1.5h4M6.5 1.5v4.5L2.8 12.4a1.2 1.2 0 0 0 1 1.8h8.4a1.2 1.2 0 0 0 1-1.8L9.5 6V1.5" />,
  handoff: <path d="M2 8h10M9 4.5 12.5 8 9 11.5" />,
  shield: <path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z" />,
  plan: <><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.8" cy="4" r=".8" /><circle cx="2.8" cy="8" r=".8" /><circle cx="2.8" cy="12" r=".8" /></>,
  database: <><ellipse cx="8" cy="3.8" rx="5" ry="2" /><path d="M3 3.8v8.4c0 1.1 2.2 2 5 2s5-.9 5-2V3.8M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" /></>,
  zap: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  code: <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  chevron: <path d="m6 4 4 4-4 4" />,
  zoomIn: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M5 7h4M7 5v4" /></>,
  zoomOut: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M5 7h4" /></>,
  fit: <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />,
  memorySave: <><path d="M3 2.5h8l2 2v9H3z" /><path d="M5 2.5v3.5h5V2.5M5 13.5v-4h6v4" /></>,
  person: <><circle cx="8" cy="5.5" r="2.8" /><path d="M2.8 14c.6-2.7 2.6-4.2 5.2-4.2s4.6 1.5 5.2 4.2" /></>,
  flag: <path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3 2 3H3.5" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3.2H9.8" />
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** Round robot glyph used for every agent avatar; tinted by --agent. */
export function RobotGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3.5" fill="currentColor" />
      <rect x="11.2" y="4.2" width="1.6" height="4" rx=".8" fill="currentColor" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" />
      <rect x="7.5" y="11" width="9" height="5" rx="2.5" fill="var(--wb-avatar-face)" />
      <circle cx="10" cy="13.5" r="1.1" fill="currentColor" />
      <circle cx="14" cy="13.5" r="1.1" fill="currentColor" />
      <rect x="3" y="11.5" width="1.6" height="4" rx=".8" fill="currentColor" />
      <rect x="19.4" y="11.5" width="1.6" height="4" rx=".8" fill="currentColor" />
    </svg>
  );
}

const TOOL_ICONS: Record<string, IconName> = {
  search_workspace: "search", read_file: "file", file_outline: "plan", write_file: "edit", run_command: "terminal", remember: "memorySave",
  remember_entity: "knowledge", remember_relation: "knowledge", create_plan: "plan", find_agent: "agents",
  list_agents: "agents", ask_agent: "handoff", delegate_task: "handoff", delegate_team: "handoff", expand_tool_result: "external"
};
export const toolIcon = (toolName: string): IconName => TOOL_ICONS[toolName] ?? "tools";

const ENTITY_ICONS: Record<string, IconName> = { concept: "knowledge", entity: "database", table: "database", event: "zap", technology: "code", file: "file", service: "tools" };
export const entityIcon = (type: string): IconName => ENTITY_ICONS[type.toLowerCase()] ?? "knowledge";
