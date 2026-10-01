/**
 * Message contract between the extension host and the React webviews.
 * Imported by both bundles, so it must not import `vscode`, `node:*` or `bun:*`.
 */

export type Surface = "sidebar" | "task" | "overview";

export type AgentRunState = "idle" | "thinking" | "running" | "delegating" | "waiting" | "failed";
export type TaskStatus = "pending" | "planning" | "active" | "blocked" | "completed" | "cancelled";

export interface AgentRef { id: string; name: string; color: string; state: AgentRunState }

export interface AgentView extends AgentRef { description: string; profile: string; canDelegate: boolean }

export interface HealthView {
  /** unknown = enabled but not contacted yet this session; unconfigured = enabled without an endpoint. */
  /** paused = a request failed, so Laya is skipped (fallback decisions) until it is resumed. */
  laya: { status: "online" | "offline" | "paused" | "unknown" | "unconfigured" | "disabled"; lastError?: string; pausedAt?: string };
  sqlite: { status: "connected" | "error"; error?: string };
  agentsRunning: number;
  tasksActive: number;
  workspace: string;
}

export interface WorkspaceView { key: string; name: string }

export interface TaskListItem { id: string; number: number; title: string; status: TaskStatus; running: boolean }

export interface PlanStepView { id: string; position: number; description: string; status: string }

export interface TaskView {
  id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  running: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  createdBy: string;
  result?: string;
  owner?: AgentRef;
  assignees: Array<{ agent: AgentRef; activity: string; status: TaskStatus }>;
  plan?: { id: string; objective: string; progress: number; steps: PlanStepView[] };
  conversationId?: string;
  counts: { events: number; toolRuns: number; filesChanged: number; subtasks: number };
  canComplete: boolean;
}

export interface FlowNode {
  id: string;
  kind: "request" | "agent" | "result";
  layer: number;
  title: string;
  subtitle: string;
  state: "done" | "active" | "pending" | "failed";
  agent?: AgentRef;
}
export interface FlowView { nodes: FlowNode[]; edges: Array<{ from: string; to: string; type: string }> }

export type WorkEventStatus = "succeeded" | "running" | "failed" | "pending_approval" | "task_completed" | "info";
export interface WorkEvent {
  id: string;
  at: string;
  kind: string;
  agent?: AgentRef;
  label: string;
  tool?: { name: string; displayName: string; ref?: string };
  status: WorkEventStatus;
}

export interface LogEntry { id: string; at: string; kind: string; agentId: string; data: string }

export interface ToolRunView {
  id: string;
  ref: string;
  agentId: string;
  toolName: string;
  displayName: string;
  status: string;
  summary: string;
  arguments: string;
  createdAt: string;
  durationMs?: number;
}

/** A file the agents wrote. The tool records only the new content, so deletions are unknown. */
export interface FileChangeView { id: string; path: string; additions: number; deletions?: number; content: string; agentId: string; at: string }

export interface TestReportView {
  passed: number;
  failed: number;
  durationS?: number;
  command: string;
  cases: Array<{ name: string; status: "passed" | "failed"; durationS?: number }>;
}

export interface KnowledgeItem { id: string; name: string; type: string; relationCount: number }

export interface ConversationItem { id: string; title: string; updatedAt: string; taskId?: string }

export interface ConversationMessage { id: string; role: "user" | "assistant" | "result"; authorName: string; agent?: AgentRef; content: string; at: string }

export interface MetricsView {
  durationMs?: number;
  toolRuns: number;
  toolFailures: number;
  toolTimeMs: number;
  delegations: number;
  decisions: number;
  layaDecisions: number;
  fallbackDecisions: number;
  memoriesRetrieved: number;
  graphFacts: number;
}

export interface TaskBundle {
  task: TaskView;
  flow: FlowView;
  events: WorkEvent[];
  logs: LogEntry[];
  toolRuns: ToolRunView[];
  files: FileChangeView[];
  tests: TestReportView | null;
  knowledge: KnowledgeItem[];
  messages: ConversationMessage[];
  metrics: MetricsView;
}

export interface SidebarBundle {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  tasks: TaskListItem[];
  conversations: ConversationItem[];
  health: HealthView;
}

export interface OverviewView {
  health: HealthView;
  counts: { total: number; running: number; completed: number; blocked: number; interrupted: number; other: number };
  toolRuns: { total: number; failed: number };
  agents: Array<AgentView & { taskCount: number }>;
  recentTasks: Array<TaskListItem & { owner?: AgentRef; updatedAt: string }>;
  activity: Array<WorkEvent & { taskId: string; taskNumber: number }>;
}

export type NavTarget = "overview" | "tasks" | "agents" | "knowledge" | "memory" | "tools" | "settings";

export interface Methods {
  "sidebar.get": { params: Record<string, never>; result: SidebarBundle };
  "overview.get": { params: Record<string, never>; result: OverviewView };
  "task.get": { params: { taskId: string }; result: TaskBundle };
  "task.latest": { params: Record<string, never>; result: { taskId?: string } };
  "task.update": { params: { taskId: string; description?: string; status?: "completed" | "cancelled" }; result: TaskView };
  "ui.openTask": { params: { taskId: string }; result: null };
  "ui.openConversation": { params: { conversationId: string }; result: null };
  "ui.openFile": { params: { path: string }; result: null };
  "ui.openTerminal": { params: Record<string, never>; result: null };
  "ui.chatWithAgent": { params: { agentId: string }; result: null };
  "ui.command": { params: { command: "newTask" | "newChat" | "manageAgents" | "testLaya" }; result: null };
  "ui.navigate": { params: { target: NavTarget }; result: null };
  "ui.showToolRun": { params: { toolRunId: string }; result: null };
}
export type MethodName = keyof Methods;

export type ToHost =
  | { kind: "ready"; surface: Surface }
  | { kind: "request"; id: string; method: MethodName; params: unknown };

export type ToWebview =
  | { kind: "init"; surface: Surface; context: { taskId?: string } }
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: { code: string; message: string } }
  /** Runtime state changed; views refetch what they show. `taskIds` narrows it when known. */
  | { kind: "changed"; scopes: Array<"agents" | "tasks" | "health" | "conversations">; taskIds?: string[] };
