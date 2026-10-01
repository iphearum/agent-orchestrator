import type { AgentDatabase } from "../../persistence/database";
import type { RuntimeActivity } from "../../core/activity";
import type { AgentDefinition } from "../../core/types";
import { WorkbenchRepository, type TaskRow, type ToolRunRow } from "../../storage/repositories/workbench";
import { isTestCommand, parseTestOutput } from "../../tools/testReport";
import type {
  AgentRef, AgentRunState, AgentView, ConversationItem, ConversationMessage, FileChangeView, FlowNode, FlowView,
  HealthView, KnowledgeItem, LogEntry, MetricsView, OverviewView, SidebarBundle, TaskBundle, TaskListItem, TaskStatus, TaskView,
  TestReportView, ToolRunView, WorkEvent, WorkspaceView
} from "../../shared/protocol";

// No `vscode` import: everything the views need from VS Code comes in through HostInfo.
export interface HostInfo {
  layaEnabled(): boolean;
  /** Configured Laya endpoint; empty means Laya was never set up. */
  layaEndpoint(): string;
  layaStatus(): { connected: boolean; paused?: boolean; pausedAt?: string; lastError?: string; lastSuccessAt?: string };
  workspaces(): WorkspaceView[];
}

const TOOL_NAMES: Record<string, string> = {
  search_workspace: "Search Files", read_file: "Read Files", file_outline: "Outline File", write_file: "Edit File", run_command: "Shell Command",
  list_agents: "List Agents", find_agent: "Find Agent", ask_agent: "Ask Agent", delegate_task: "Delegate", delegate_team: "Team",
  remember: "Save Memory", remember_entity: "Update Knowledge", remember_relation: "Update Knowledge",
  create_plan: "Create Plan", expand_tool_result: "Expand Result"
};
/** Built-in tools by name; MCP tools ("mcp_github_list_issues") and CLI-agent tools ("claude-code:Read") get readable labels. */
export function toolDisplayName(name: string): string {
  if (TOOL_NAMES[name]) return TOOL_NAMES[name];
  if (/^mcp_/i.test(name)) return `MCP \u00b7 ${name.slice(4).replace(/_/g, " ")}`;
  if (name.includes(":")) return name.replace(":", " \u00b7 ");
  return name.replace(/_/g, " ");
}
/** Delegation tool runs are shown through their agent_messages instead, so they are not listed twice. */
const HANDOFF_TOOLS = new Set(["ask_agent", "delegate_task", "delegate_team"]);
const TASK_STATUSES: TaskStatus[] = ["pending", "planning", "active", "blocked", "completed", "cancelled"];
const STOP_WORDS = new Set(["this", "that", "with", "from", "have", "what", "when", "where", "which", "should", "would", "could", "please", "about", "into", "there", "their", "them", "then", "than", "make", "help", "need", "want", "using", "after", "before"]);

/** SQLite CURRENT_TIMESTAMP is UTC without a zone ("2026-09-29 10:24:00"). */
export function isoTime(value: string | null | undefined): string {
  if (!value) return "";
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

const json = (text: string | null | undefined): any => {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};
const oneLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const taskStatus = (value: string): TaskStatus => (TASK_STATUSES as string[]).includes(value) ? value as TaskStatus : "pending";
const stateActivity: Record<AgentRunState, string> = {
  thinking: "Thinking", running: "Working", delegating: "Delegating", waiting: "Waiting for approval", failed: "Failed", idle: "Idle"
};

/** Entities are stored normalised (lowercase); show the original spelling when JEV kept it. */
const displayNameOf = (row: { name: string; data_json?: string | null }) => {
  const data = json(row.data_json ?? undefined);
  return typeof data?.displayName === "string" && data.displayName ? data.displayName : row.name;
};

export class WorkbenchViews {
  readonly repo: WorkbenchRepository;

  constructor(private readonly db: AgentDatabase, private readonly activity: RuntimeActivity, private readonly host: HostInfo) {
    this.repo = new WorkbenchRepository(db.connection);
  }

  health(): HealthView {
    let sqlite: HealthView["sqlite"] = { status: "connected" };
    try { if (!this.repo.ping()) sqlite = { status: "error", error: "SQLite did not answer." }; }
    catch (error) { sqlite = { status: "error", error: error instanceof Error ? error.message : String(error) }; }
    const status = this.host.layaStatus();
    const laya: HealthView["laya"] = !this.host.layaEnabled() ? { status: "disabled" }
      : !this.host.layaEndpoint().trim() ? { status: "unconfigured" }
      : status.paused ? { status: "paused", lastError: status.lastError, pausedAt: status.pausedAt }
      : status.connected ? { status: "online" }
        : status.lastError ? { status: "offline", lastError: status.lastError }
          : { status: "unknown" };
    return {
      laya, sqlite,
      agentsRunning: this.activity.agentsRunning(),
      tasksActive: this.activity.runningRootIds().length,
      workspace: this.host.workspaces()[0]?.name ?? "No workspace"
    };
  }

  sidebar(): SidebarBundle {
    return {
      workspaces: this.host.workspaces(),
      agents: this.db.listAgents().map(agent => this.agentView(agent)),
      tasks: this.repo.listRootTasks(8).map(row => this.taskListItem(row)),
      conversations: this.repo.recentConversations(6).map((row): ConversationItem => ({
        id: row.id, title: row.title || "Conversation", updatedAt: isoTime(row.updated_at), taskId: row.task_id ?? undefined
      })),
      health: this.health()
    };
  }

  latestTaskId() { return this.repo.latestRootTaskId(); }

  overview(): OverviewView {
    const agents = this.db.listAgents();
    const names = new Map(agents.map(agent => [agent.id, agent.name]));
    const ref = (agentId: string | null | undefined): AgentRef | undefined => agentId
      ? { id: agentId, name: names.get(agentId) ?? agentId, color: agentId, state: this.activity.agentState(agentId) }
      : undefined;

    const counts: OverviewView["counts"] = { total: 0, running: 0, completed: 0, blocked: 0, interrupted: 0, other: 0 };
    for (const row of this.repo.rootStatusCounts()) {
      counts.total += row.count;
      if (row.status === "completed") counts.completed += row.count;
      else if (row.status === "blocked") counts.blocked += row.count;
      else if (row.status !== "active") counts.other += row.count;
    }
    for (const id of this.repo.activeRootIds()) {
      if (this.activity.isRootRunning(id)) counts.running++; else counts.interrupted++;
    }

    const taskCounts = this.repo.agentTaskCounts();
    const numbers = this.repo.rootNumbers();
    const activity: OverviewView["activity"] = [];
    for (const row of this.repo.recentToolRuns(20)) {
      if (HANDOFF_TOOLS.has(row.tool_name)) continue;
      activity.push({
        id: row.id, at: isoTime(row.created_at), kind: "tool", agent: ref(row.agent_id), label: toolLabel(row),
        tool: { name: row.tool_name, displayName: toolDisplayName(row.tool_name), ref: `tool://${row.id}` },
        status: row.status === "failed" ? "failed" : "succeeded", taskId: row.root_id, taskNumber: numbers.get(row.root_id) ?? 0
      });
    }
    for (const row of this.repo.recentHandoffs(10)) {
      const content = json(row.payload_json)?.content;
      activity.push({
        id: row.id, at: isoTime(row.created_at), kind: "handoff", agent: ref(row.sender_agent_id),
        label: `${row.type === "ask" ? "Asked" : "Delegated to"} ${names.get(row.receiver_agent_id ?? "") ?? row.receiver_agent_id}: ${oneLine(String(content ?? ""), 120)}`,
        status: "succeeded", taskId: row.root_id, taskNumber: numbers.get(row.root_id) ?? 0
      });
    }
    activity.sort((a, b) => b.at.localeCompare(a.at));

    return {
      health: this.health(),
      counts,
      toolRuns: this.repo.toolRunTotals(),
      agents: agents.map(agent => ({ ...this.agentView(agent), taskCount: taskCounts.get(agent.id) ?? 0 })),
      recentTasks: this.repo.listRootTasks(8).map(row => ({
        ...this.taskListItem(row), owner: ref(row.agent_id), updatedAt: isoTime(row.completed_at || row.created_at)
      })),
      activity: activity.slice(0, 15)
    };
  }

  task(taskId: string): TaskBundle | undefined {
    const root = this.repo.getRootTask(taskId);
    if (!root) return undefined;
    const agents = new Map(this.db.listAgents().map(agent => [agent.id, agent]));
    const ref = (agentId: string | null | undefined): AgentRef | undefined => {
      if (!agentId) return undefined;
      const agent = agents.get(agentId);
      return { id: agentId, name: agent?.name ?? agentId, color: agentId, state: this.agentStateFor(root.id, agentId) };
    };
    const tree = this.repo.taskTree(root.id);
    const traces = this.repo.traces(root.id);
    const toolRows = this.repo.toolRuns(root.id);
    const messages = this.repo.agentMessages(root.id);
    const running = this.activity.isRootRunning(root.id);
    const conversationId = this.repo.conversationForTask(root.id);

    const toolDurations = new Map<string, number>();
    for (const trace of traces) {
      if (trace.kind !== "tool") continue;
      const data = json(trace.data_json);
      if (data?.toolRunId && typeof data.durationMs === "number") toolDurations.set(data.toolRunId, data.durationMs);
    }

    const events = this.events(root, traces, toolRows, messages, ref, running);
    const toolRuns = toolRows.map(row => this.toolRunView(row, toolDurations.get(row.id)));
    const files = this.files(toolRows);
    const flow = this.flow(root, tree, messages, ref, running);
    const task = this.taskView(root, tree, ref, running, conversationId, {
      events: events.length, toolRuns: toolRuns.length, filesChanged: files.length, subtasks: tree.length - 1
    }, events.at(-1)?.at);

    return {
      task, flow, events, toolRuns, files,
      logs: traces.map((row): LogEntry => ({ id: row.id, at: isoTime(row.created_at), kind: row.kind, agentId: row.agent_id, data: row.data_json })),
      tests: this.tests(toolRows),
      knowledge: this.knowledge(root),
      messages: conversationId ? this.conversation(conversationId, ref) : [],
      metrics: this.metrics(root, traces, toolRows, messages)
    };
  }

  updateTask(taskId: string, change: { description?: string; status?: "completed" | "cancelled" }): TaskView {
    const root = this.repo.getRootTask(taskId);
    if (!root) throw new Error("Task not found.");
    if (change.status) {
      if (this.activity.isRootRunning(taskId)) throw new Error("The task is still running. Wait for it to finish before closing it.");
      this.repo.setTaskStatus(taskId, change.status);
    }
    if (change.description !== undefined) this.repo.setTaskDescription(taskId, change.description);
    const bundle = this.task(taskId);
    if (!bundle) throw new Error("Task not found.");
    return bundle.task;
  }

  conversationTask(conversationId: string) { return this.repo.latestTaskForConversation(conversationId); }

  private agentStateFor(rootId: string, agentId: string): AgentRunState {
    return this.activity.agentStateInRoot(rootId, agentId) ?? "idle";
  }

  private agentView(agent: AgentDefinition): AgentView {
    return {
      id: agent.id, name: agent.name, color: agent.id, state: this.activity.agentState(agent.id),
      description: agent.description, profile: agent.layaProfile ?? "general", canDelegate: agent.canDelegate
    };
  }

  private taskListItem(row: TaskRow): TaskListItem {
    return { id: row.id, number: row.number, title: oneLine(row.title, 80), status: taskStatus(row.status), running: this.activity.isRootRunning(row.id) };
  }

  private taskView(root: TaskRow, tree: TaskRow[], ref: (id: string | null) => AgentRef | undefined, running: boolean, conversationId: string | undefined, counts: TaskView["counts"], lastEventAt?: string): TaskView {
    const assignees = new Map<string, TaskView["assignees"][number]>();
    for (const row of tree) {
      const agent = ref(row.agent_id);
      if (!agent) continue;
      const liveState = this.activity.agentStateInRoot(root.id, agent.id);
      const status = taskStatus(row.status);
      // Later subtasks overwrite earlier ones, so each agent shows its latest assignment.
      assignees.set(agent.id, {
        agent, status,
        activity: liveState ? stateActivity[liveState] : status === "completed" ? "Done" : status === "blocked" ? "Stopped" : running ? "Queued" : "Interrupted"
      });
    }
    const planRows = this.repo.activePlan(root.id);
    const steps = planRows.filter(row => row.step_id).map(row => ({ id: row.step_id!, position: row.position ?? 0, description: row.description ?? "", status: row.status ?? "pending" }));
    const counted = steps.filter(step => step.status !== "skipped");
    const status = taskStatus(root.status);
    return {
      id: root.id,
      number: root.number,
      title: oneLine(root.title.split(/\r?\n/)[0] || root.title, 120),
      description: root.description ?? root.title,
      status, running,
      priority: root.priority ?? 0,
      createdAt: isoTime(root.created_at),
      updatedAt: lastEventAt || isoTime(root.completed_at || root.created_at),
      completedAt: root.completed_at ? isoTime(root.completed_at) : undefined,
      createdBy: "You",
      result: root.result ?? undefined,
      owner: ref(root.agent_id),
      assignees: [...assignees.values()],
      plan: planRows.length ? {
        id: planRows[0].plan_id,
        objective: planRows[0].objective ?? "",
        progress: counted.length ? counted.filter(step => step.status === "completed").length / counted.length : 0,
        steps
      } : undefined,
      conversationId,
      counts,
      canComplete: !running && status !== "completed" && status !== "cancelled"
    };
  }

  private flow(root: TaskRow, tree: TaskRow[], messages: ReturnType<WorkbenchRepository["agentMessages"]>, ref: (id: string | null) => AgentRef | undefined, running: boolean): FlowView {
    const layers = new Map<string, number>();
    const agentTasks = new Map<string, TaskRow[]>();
    for (const row of tree) {
      if (!row.agent_id) continue;
      layers.set(row.agent_id, Math.min(layers.get(row.agent_id) ?? Infinity, row.depth + 1));
      agentTasks.set(row.agent_id, [...(agentTasks.get(row.agent_id) ?? []), row]);
    }
    const nodes: FlowNode[] = [{
      id: "request", kind: "request", layer: 0, title: "Request", subtitle: oneLine(root.title, 60), state: "done"
    }];
    for (const [agentId, layer] of layers) {
      const rows = agentTasks.get(agentId) ?? [];
      const live = this.activity.agentStateInRoot(root.id, agentId);
      const latest = rows[rows.length - 1];
      const state: FlowNode["state"] = live ? "active"
        : rows.some(row => row.status === "blocked") ? "failed"
          : rows.every(row => row.status === "completed") ? "done" : running ? "pending" : "failed";
      const agent = ref(agentId)!;
      nodes.push({ id: `agent:${agentId}`, kind: "agent", layer, agent, title: agent.name, subtitle: live ? stateActivity[live] : oneLine(latest?.title ?? "", 48), state });
    }
    const edges: FlowView["edges"] = [];
    const seen = new Set<string>();
    const add = (from: string, to: string, type: string) => {
      const key = `${from}>${to}`;
      if (from === to || seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, type });
    };
    if (root.agent_id) add("request", `agent:${root.agent_id}`, "request");
    for (const message of messages) {
      if ((message.type === "delegate" || message.type === "ask") && message.sender_agent_id && message.receiver_agent_id && layers.has(message.receiver_agent_id)) {
        add(`agent:${message.sender_agent_id}`, `agent:${message.receiver_agent_id}`, "handoff");
      }
    }
    // Columns follow the hand-offs, so work that waits for other work (a reviewer) sits after it, not beside it.
    const layerOf = new Map(nodes.map(node => [node.id, node.layer]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let moved = false;
      for (const edge of edges) {
        const next = (layerOf.get(edge.from) ?? 0) + 1;
        if (next > (layerOf.get(edge.to) ?? 0)) { layerOf.set(edge.to, next); moved = true; }
      }
      if (!moved) break;
    }
    for (const node of nodes) node.layer = layerOf.get(node.id) ?? node.layer;

    const rootStatus = taskStatus(root.status);
    nodes.push({
      id: "result", kind: "result", layer: Math.max(0, ...nodes.map(node => node.layer)) + 1, title: "Result",
      subtitle: root.result ? oneLine(root.result, 60) : running ? "In progress" : "No result yet",
      state: rootStatus === "completed" ? "done" : rootStatus === "blocked" ? "failed" : running ? "pending" : "failed"
    });
    // The result is drawn from the end of the chain, as in the design (… → Reviewer → Result): the agents that hand
    // no work on. Their answers flow back up to the root agent, which writes the reply.
    const ends = [...layers.keys()].filter(agentId => !edges.some(edge => edge.from === `agent:${agentId}`));
    for (const agentId of ends.length ? ends : root.agent_id ? [root.agent_id] : []) add(`agent:${agentId}`, "result", "result");
    return { nodes, edges };
  }

  private events(root: TaskRow, traces: ReturnType<WorkbenchRepository["traces"]>, toolRows: ToolRunRow[], messages: ReturnType<WorkbenchRepository["agentMessages"]>, ref: (id: string | null) => AgentRef | undefined, running: boolean): WorkEvent[] {
    // Each table has its own rowid order; merge them by timestamp, keeping each source's internal order.
    const items: Array<WorkEvent & { order: number }> = [];
    let order = 0;
    const push = (event: WorkEvent) => items.push({ ...event, order: order++ });

    for (const trace of traces) {
      if (trace.kind !== "routing") continue;
      const data = json(trace.data_json) ?? {};
      const agent = ref(trace.agent_id);
      const confidence = typeof data.agent?.confidence === "number" ? ` (${Math.round(data.agent.confidence * 100)}% confidence)` : "";
      const how = data.source === "laya" ? `Laya routed the request${confidence}` : data.source === "rules" ? `Rules routed the request${confidence}` : "Started the request";
      push({ id: trace.id, at: isoTime(trace.created_at), kind: "route", agent, label: `${how} to ${agent?.name ?? trace.agent_id}.`, status: "info" });
    }
    for (const message of messages) {
      const payload = json(message.payload_json);
      const content = typeof payload?.content === "string" ? payload.content : "";
      const sender = ref(message.sender_agent_id);
      const receiver = ref(message.receiver_agent_id);
      const at = isoTime(message.created_at);
      if (message.type === "delegate" || message.type === "ask") {
        const verb = message.type === "ask" ? "Asked" : "Delegated to";
        // The row already names the sender, so drop the "Consultation request from Lead:" header the receiver gets.
        const request = content.replace(/^Consultation request from [^:\n]+:\s*/, "");
        push({ id: message.id, at, kind: "handoff", agent: sender, label: `${verb} ${receiver?.name ?? message.receiver_agent_id}: ${oneLine(request, 140)}`, status: "succeeded" });
      } else if (message.type === "response") {
        push({ id: message.id, at, kind: "result", agent: sender, label: `Reported back to ${receiver?.name ?? message.receiver_agent_id}: ${oneLine(content, 140)}`, status: "succeeded" });
      } else if (message.type === "assistant" && content.trim()) {
        push({ id: message.id, at, kind: "message", agent: sender, label: oneLine(content, 180), status: "info" });
      }
    }
    for (const row of toolRows) {
      if (HANDOFF_TOOLS.has(row.tool_name)) continue;
      push({
        id: row.id, at: isoTime(row.created_at), kind: "tool", agent: ref(row.agent_id),
        label: toolLabel(row), tool: { name: row.tool_name, displayName: toolDisplayName(row.tool_name), ref: `tool://${row.id}` },
        status: row.status === "failed" ? "failed" : "succeeded"
      });
    }
    const status = taskStatus(root.status);
    if (status === "completed" && root.completed_at) {
      // The final answer is usually also the agent's last message; don't show it twice.
      const alreadyShown = root.result && messages.some(message => message.type === "assistant" && json(message.payload_json)?.content?.trim() === root.result!.trim());
      const label = root.result && !alreadyShown ? oneLine(root.result, 180) : "Task completed.";
      push({ id: `${root.id}:done`, at: isoTime(root.completed_at), kind: "result", agent: ref(root.agent_id), label, status: "task_completed" });
    } else if (status === "blocked") {
      push({ id: `${root.id}:stopped`, at: isoTime(root.completed_at || root.created_at), kind: "error", agent: ref(root.agent_id), label: `Stopped: ${oneLine(root.result ?? "unknown error", 180)}`, status: "failed" });
    }
    items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
    const events: WorkEvent[] = items.map(({ order: _order, ...event }) => event);

    if (running) {
      const now = new Date().toISOString();
      const seen = new Set<string>();
      for (const row of this.repo.taskTree(root.id)) {
        const agentId = row.agent_id;
        if (!agentId || seen.has(agentId)) continue;
        const state = this.activity.agentStateInRoot(root.id, agentId);
        if (!state) continue;
        seen.add(agentId);
        events.push({ id: `live:${agentId}`, at: now, kind: "live", agent: ref(agentId), label: `${stateActivity[state]}…`, status: state === "waiting" ? "pending_approval" : "running" });
      }
    }
    return events;
  }

  private toolRunView(row: ToolRunRow, durationMs?: number): ToolRunView {
    return {
      id: row.id, ref: `tool://${row.id}`, agentId: row.agent_id, toolName: row.tool_name,
      displayName: toolDisplayName(row.tool_name), status: row.status ?? "completed",
      summary: resultSummary(row), arguments: row.arguments_json ?? "{}", createdAt: isoTime(row.created_at), durationMs
    };
  }

  private files(toolRows: ToolRunRow[]): FileChangeView[] {
    const latest = new Map<string, FileChangeView>();
    for (const row of toolRows) {
      if (row.tool_name !== "write_file" || row.status === "failed") continue;
      const args = json(row.arguments_json);
      if (typeof args?.path !== "string") continue;
      const content = typeof args.content === "string" ? args.content : "";
      latest.set(args.path, {
        id: row.id, path: args.path, content, agentId: row.agent_id, at: isoTime(row.created_at),
        additions: content ? content.split(/\r?\n/).length : 0
      });
    }
    return [...latest.values()];
  }

  private tests(toolRows: ToolRunRow[]): TestReportView | null {
    for (const row of [...toolRows].reverse()) {
      if (row.tool_name !== "run_command") continue;
      const command = String(json(row.arguments_json)?.command ?? "");
      if (!isTestCommand(command)) continue;
      const result = json(row.result_json);
      const output = [result?.stdout, result?.stderr].filter(value => typeof value === "string").join("\n");
      const report = parseTestOutput(command, output);
      if (report) return report;
    }
    return null;
  }

  private knowledge(root: TaskRow): KnowledgeItem[] {
    const terms = [...new Set((`${root.title} ${root.description ?? ""}`.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).filter(term => !STOP_WORDS.has(term)))].slice(0, 12);
    // What the task actually touched or recorded comes first; name matches on the title fill the rest.
    const seen = new Set<string>();
    const rows = [...this.repo.entitiesForTask(root.id, 6), ...this.repo.entitiesMatching(terms, 6)].filter(row => !seen.has(row.id) && seen.add(row.id)).slice(0, 6);
    return rows.map(row => ({ id: row.id, name: displayNameOf(row), type: row.type, relationCount: row.relation_count }));
  }

  private conversation(conversationId: string, ref: (id: string | null) => AgentRef | undefined): ConversationMessage[] {
    return this.repo.conversationMessages(conversationId, 60).map(row => {
      const agent = row.role === "user" ? undefined : ref(row.agent_id);
      return {
        id: row.id, role: row.role === "user" ? "user" : row.role === "result" ? "result" : "assistant",
        authorName: row.role === "user" ? "You" : agent?.name ?? "Agent", agent, content: row.content, at: isoTime(row.created_at)
      };
    });
  }

  private metrics(root: TaskRow, traces: ReturnType<WorkbenchRepository["traces"]>, toolRows: ToolRunRow[], messages: ReturnType<WorkbenchRepository["agentMessages"]>): MetricsView {
    const metrics: MetricsView = { toolRuns: toolRows.length, toolFailures: toolRows.filter(row => row.status === "failed").length, toolTimeMs: 0, delegations: 0, decisions: 0, layaDecisions: 0, fallbackDecisions: 0, memoriesRetrieved: 0, graphFacts: 0 };
    if (root.completed_at) metrics.durationMs = Date.parse(isoTime(root.completed_at)) - Date.parse(isoTime(root.created_at));
    metrics.delegations = messages.filter(message => message.type === "delegate" || message.type === "ask").length;
    for (const trace of traces) {
      const data = json(trace.data_json) ?? {};
      if (trace.kind === "tool" && typeof data.durationMs === "number") metrics.toolTimeMs += data.durationMs;
      if (trace.kind === "decision" || trace.kind === "routing") {
        metrics.decisions++;
        if (data.source === "laya") metrics.layaDecisions++; else metrics.fallbackDecisions++;
      }
      if (trace.kind === "retrieval") {
        metrics.memoriesRetrieved += Number(data.memoryCount) || 0;
        metrics.graphFacts += Number(data.graphFactCount) || 0;
      }
    }
    return metrics;
  }
}

function toolLabel(row: ToolRunRow): string {
  const args = json(row.arguments_json) ?? {};
  const failed = row.status === "failed";
  let label: string;
  switch (row.tool_name) {
    case "search_workspace": label = `Searched the workspace for "${oneLine(String(args.query ?? ""), 60)}"`; break;
    case "read_file": label = `Read ${args.path ?? "a file"}${args.start_line || args.end_line ? ` (lines ${args.start_line ?? 1}-${args.end_line ?? "…"})` : ""}`; break;
    case "file_outline": label = `Outlined ${args.path ?? "a file"}`; break;
    case "write_file": label = `Wrote ${args.path ?? "a file"}`; break;
    case "run_command": label = `Ran \`${oneLine(String(args.command ?? ""), 80)}\``; break;
    case "remember": label = `Saved a memory: ${oneLine(String(args.content ?? ""), 80)}`; break;
    case "remember_entity": label = `Recorded ${args.type ?? "entity"} "${args.name ?? ""}"`; break;
    case "remember_relation": label = `Linked ${args.source_name ?? "?"} ${args.predicate ?? "→"} ${args.target_name ?? "?"}`; break;
    case "create_plan": label = `Created a plan: ${oneLine(String(args.objective ?? ""), 80)}`; break;
    case "find_agent": label = `Looked for an agent that can "${oneLine(String(args.capability ?? ""), 50)}"`; break;
    case "list_agents": label = "Listed the available agents"; break;
    case "expand_tool_result": label = "Expanded an earlier tool result"; break;
    default: label = `Used ${toolDisplayName(row.tool_name)}${typeof args.path === "string" ? ` on ${args.path}` : ""}`;
  }
  return failed ? `${label} — failed: ${oneLine(resultSummary(row), 100)}` : `${label}.`;
}

function resultSummary(row: ToolRunRow): string {
  const result = json(row.result_json);
  if (result?.error) return String(result.error);
  if (row.tool_name === "run_command" && result) return `exit ${result.exitCode ?? "?"} · ${oneLine(String(result.stdout || result.stderr || ""), 140)}`;
  return oneLine(row.result_json ?? "", 160);
}
