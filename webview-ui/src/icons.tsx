import {
  ArrowRight, Check, ChevronRight, CircleAlert, Code, Database,
  ExternalLink, File, Flag, FlaskConical, LayoutDashboard, ListChecks, ListTodo,
  MessageSquare, Microchip, Network, Pencil, Plus, RefreshCw, Scan, Search, Save,
  Settings, Shield, SquareTerminal, UserRound, Wrench, X, Zap, ZoomIn, ZoomOut,
  type LucideIcon
} from "lucide-react";

const ICONS = {
  overview: LayoutDashboard,
  tasks: ListTodo,
  agents: Network,
  knowledge: Network,
  memory: Microchip,
  tools: Wrench,
  settings: Settings,
  add: Plus,
  chat: MessageSquare,
  check: Check,
  close: X,
  error: CircleAlert,
  search: Search,
  file: File,
  edit: Pencil,
  terminal: SquareTerminal,
  beaker: FlaskConical,
  handoff: ArrowRight,
  shield: Shield,
  plan: ListChecks,
  database: Database,
  zap: Zap,
  code: Code,
  chevron: ChevronRight,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Scan,
  external: ExternalLink,
  memorySave: Save,
  person: UserRound,
  flag: Flag,
  refresh: RefreshCw
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  if (name === "agents") {
    return <AgentIcon size={size} className={className} title={title} />;
  }
  const Lucide = ICONS[name];
  return <Lucide className={`icon ${className ?? ""}`} size={size} strokeWidth={1.7} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title} />;
}

function AgentIcon({ size, className, title }: { size: number; className?: string; title?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title}>
      <path d="M12 3v2.2" />
      <circle cx="12" cy="2.5" r="1.1" fill="currentColor" stroke="none" />
      <rect x="4.5" y="5.5" width="15" height="12.5" rx="4.3" />
      <path d="M4.5 10H3a1.5 1.5 0 0 0 0 3h1.5M19.5 10H21a1.5 1.5 0 0 1 0 3h-1.5" />
      <rect x="7.3" y="8.4" width="9.4" height="5.5" rx="2.3" fill="currentColor" fillOpacity=".14" />
      <circle cx="10" cy="11" r=".85" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11" r=".85" fill="currentColor" stroke="none" />
      <path d="M10 12.4h4M8 19.2h8M9.5 18v1.2M14.5 18v1.2" />
    </svg>
  );
}

/** Round robot glyph used for every agent avatar; tinted by --agent. */
export function RobotGlyph() {
  return (
    <svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">
      <path d="M9 20.5h14a5 5 0 0 1 5 5v1H4v-1a5 5 0 0 1 5-5Z" fill="currentColor" opacity=".82" />
      <path d="M16 4v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="3" r="2" fill="currentColor" />
      <rect x="5" y="7" width="22" height="16" rx="6" fill="currentColor" />
      <path d="M5 12H3.5a2 2 0 0 0 0 4H5M27 12h1.5a2 2 0 0 1 0 4H27" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="8.5" y="10" width="15" height="8.5" rx="3.5" fill="var(--wb-avatar-face)" />
      <ellipse cx="12.3" cy="13.5" rx="1.25" ry="1.65" fill="currentColor" />
      <ellipse cx="19.7" cy="13.5" rx="1.25" ry="1.65" fill="currentColor" />
      <path d="M13 16.2q3 2.7 6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 26v2M21 26v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
