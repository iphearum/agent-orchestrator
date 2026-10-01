const vscode = acquireVsCodeApi();
const $ = selector => document.querySelector(selector);
const NS = "http://www.w3.org/2000/svg";
const palette = ["#4a8dff", "#16b9a5", "#aa79ed", "#e99c48", "#54b7ff", "#e16c83", "#53bd84"];
const state = { snapshot: {}, section: "overview", view: "flow", filter: "work", detail: "task", taskId: "", agentId: "" };

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}
function svgNode(tag, attrs = {}, text) {
  const item = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  if (text !== undefined) item.textContent = String(text);
  return item;
}
function dateOf(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatTime(value) {
  const date = dateOf(value);
  return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}
function formatDate(value) {
  const date = dateOf(value);
  return date ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}
function statusLabel(status) {
  return ({ active: "In Progress", running: "In Progress", completed: "Completed", blocked: "Blocked", failed: "Failed", pending: "Queued", queued: "Queued", cancelled: "Cancelled" })[status] || "Idle";
}
function initials(name) {
  return String(name || "Agent").split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase();
}
function agents() { return state.snapshot.agents || []; }
function tasks() { return state.snapshot.tasks || []; }
function roots() { return tasks().filter(task => !task.parent_id); }
function selectedTask() {
  return tasks().find(task => task.id === state.taskId) || roots()[0] || null;
}
function relatedTasks(task) {
  if (!task) return [];
  return tasks().filter(item => item.root_id === task.root_id);
}
function relatedTaskIds(task) { return new Set(relatedTasks(task).map(item => item.id)); }
function agentFor(id) { return agents().find(agent => agent.id === id); }
function agentColor(id) {
  const index = Math.max(0, agents().findIndex(agent => agent.id === id));
  return palette[index % palette.length];
}
function parseToolArgs(value) {
  if (value && typeof value === "object") return value;
  try { const parsed = JSON.parse(value || "{}"); return typeof parsed === "string" ? JSON.parse(parsed) : parsed; }
  catch { return {}; }
}
function writeRuns(task) {
  const ids = relatedTaskIds(task);
  return (state.snapshot.toolRuns || []).filter(run => ids.has(run.taskId) && run.name === "write_file");
}
function taskPlans(task) {
  const ids = relatedTaskIds(task);
  return (state.snapshot.plans || []).filter(plan => ids.has(plan.taskId));
}
function taskUpdatedAt(task) {
  const ids = relatedTaskIds(task);
  const candidates = [
    ...(state.snapshot.traces || []).filter(item => ids.has(item.task_id)).map(item => item.created_at),
    ...(state.snapshot.messages || []).filter(item => ids.has(item.task_id)).map(item => item.created_at),
    ...(state.snapshot.toolRuns || []).filter(item => ids.has(item.taskId)).map(item => item.createdAt),
    ...(relatedTasks(task).map(item => item.completed_at).filter(Boolean))
  ].filter(Boolean).sort((a, b) => (dateOf(a)?.getTime() || 0) - (dateOf(b)?.getTime() || 0));
  return candidates.at(-1) || task.completed_at || task.created_at;
}
function dataForTrace(trace) { return trace.data && typeof trace.data === "object" ? trace.data : {}; }
function traceText(trace) {
  const data = dataForTrace(trace);
  if (trace.kind === "tool") return `${data.name || "Tool"}${data.durationMs ? ` · ${data.durationMs} ms` : ""}${data.resultPreview ? ` · ${String(data.resultPreview).slice(0, 140)}` : ""}`;
  if (trace.kind === "routing") return `Route selected ${data.agent?.value || trace.agent_id || "an agent"}`;
  if (trace.kind === "retrieval") return `Retrieved ${data.memoryCount || 0} memories and ${data.graphFactCount || 0} knowledge facts`;
  if (trace.kind === "decision") return `Decision policy · ${data.source || "local"}`;
  if (trace.kind === "error") return data.message || data.error || "Runtime error";
  return data.message || trace.kind || "Runtime activity";
}
function activityEvents(task) {
  if (!task) return [];
  const ids = relatedTaskIds(task);
  const events = [];
  for (const trace of state.snapshot.traces || []) {
    if (!ids.has(trace.task_id)) continue;
    events.push({ type: "trace", kind: trace.kind, agentId: trace.agent_id, taskId: trace.task_id, time: trace.created_at, text: traceText(trace), raw: trace });
  }
  for (const message of state.snapshot.messages || []) {
    if (!ids.has(message.task_id)) continue;
    const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    events.push({ type: "message", kind: message.type, agentId: message.sender_agent_id, taskId: message.task_id, time: message.created_at, text: payload.content || message.type, raw: message });
  }
  for (const linkedTask of relatedTasks(task)) {
    if (linkedTask.result) events.push({ type: "result", kind: "result", agentId: linkedTask.agent_id, taskId: linkedTask.id, time: linkedTask.completed_at || linkedTask.created_at, text: String(linkedTask.result).slice(0, 600), raw: linkedTask });
  }
  for (const run of state.snapshot.toolRuns || []) {
    if (!ids.has(run.taskId)) continue;
    const args = parseToolArgs(run.arguments);
    const text = run.name === "write_file" ? `Updated ${args.path || "workspace file"}` : `${run.name}${args.path ? ` · ${args.path}` : ""}`;
    events.push({ type: "tool", kind: run.status === "failed" ? "error" : "tool", agentId: run.agentId, taskId: run.taskId, time: run.createdAt, text, raw: run });
  }
  return events.sort((a, b) => (dateOf(a.time)?.getTime() || 0) - (dateOf(b.time)?.getTime() || 0)).slice(-160);
}
function fileEntries(task) {
  const seen = new Map();
  for (const run of writeRuns(task)) {
    const args = parseToolArgs(run.arguments);
    if (!args.path) continue;
    const path = String(args.path);
    if (!seen.has(path)) seen.set(path, { path, updatedAt: run.createdAt, agentId: run.agentId, status: run.status, size: Number(args.contentChars) || String(args.content || "").length });
  }
  return [...seen.values()];
}

function drawFlow(task) {
  const root = $("#agent-flow");
  root.replaceChildren();
  if (!task) {
    const empty = node("div", "flow-empty");
    empty.append(node("span", "", "Start an agent conversation to see task routing and work here."));
    const start = node("button", "empty-action", "Open agent chat");
    start.type = "button";
    start.addEventListener("click", () => vscode.postMessage({ type: "openChat" }));
    empty.append(start);
    root.append(empty);
    return;
  }
  const linked = relatedTasks(task);
  const children = linked.filter(item => item.id !== task.id);
  const height = Math.max(220, 34 + Math.max(1, children.length) * 76);
  const centerY = Math.round(height / 2);
  const graph = svgNode("svg", { class: "flow-svg", viewBox: `0 0 1000 ${height}`, role: "img", "aria-label": "Selected task agent flow", preserveAspectRatio: "xMinYMid meet" });
  const link = (x1, y1, x2, y2, color) => graph.append(svgNode("path", { class: "flow-link", d: `M ${x1} ${y1} C ${x1 + 52} ${y1}, ${x2 - 52} ${y2}, ${x2} ${y2}`, style: `--link-color:${color}` }));
  const box = (x, y, width, title, subtitle, options = {}) => {
    const group = svgNode("g", { class: options.agentId ? "flow-clickable" : "" });
    if (options.agentId) {
      group.dataset.agent = options.agentId;
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `View ${title} agent details`);
    }
    group.append(svgNode("rect", { class: options.agentId ? "flow-node agent" : "flow-node", x, y: y - 30, width, height: 60, rx: 8, style: options.agentId ? `--agent-color:${options.color}` : "" }));
    group.append(svgNode("circle", { class: options.agentId ? "flow-avatar" : "flow-avatar", cx: x + 26, cy: y, r: 15, style: `--agent-color:${options.color || "var(--blue)"}` }));
    group.append(svgNode("text", { class: "flow-icon", x: x + 26, y: y + 5, "text-anchor": "middle" }, options.icon || initials(title)));
    group.append(svgNode("text", { class: "flow-title", x: x + 49, y: y - 3 }, String(title).slice(0, 23)));
    group.append(svgNode("text", { class: "flow-subtitle", x: x + 49, y: y + 14 }, String(subtitle).slice(0, 28)));
    if (options.state) group.append(svgNode("circle", { class: `flow-state ${options.state === "completed" ? "done" : options.state === "pending" ? "waiting" : ""}`, cx: x + width - 12, cy: y - 18, r: 4 }));
    graph.append(group);
  };
  const requestX = 24, rootX = 222, childX = 500, resultX = 792;
  link(requestX + 142, centerY, rootX, centerY, "var(--blue)");
  box(requestX, centerY, 142, "User Request", task.title || "Task", { icon: "◉", color: "var(--blue)" });
  const owner = agentFor(task.agent_id);
  const ownerName = owner?.name || task.agent_id || "Agent";
  box(rootX, centerY, 202, ownerName, task.status === "active" ? "Working on the task" : statusLabel(task.status), { agentId: task.agent_id, color: agentColor(task.agent_id), state: task.status });
  if (children.length) {
    const rows = children.slice(0, 6);
    const rowYs = rows.map((_, i) => 38 + i * 76);
    rows.forEach((child, i) => {
      const childAgent = agentFor(child.agent_id);
      const y = rowYs[i];
      link(rootX + 202, centerY, childX, y, agentColor(child.agent_id));
      link(childX + 202, y, resultX, centerY, agentColor(child.agent_id));
      box(childX, y, 202, childAgent?.name || child.agent_id || "Agent", child.title || statusLabel(child.status), { agentId: child.agent_id, color: agentColor(child.agent_id), state: child.status });
    });
    if (children.length > rows.length) {
      const y = Math.min(height - 22, rowYs[rowYs.length - 1] + 38);
      graph.append(svgNode("text", { class: "flow-subtitle", x: childX + 8, y }, `+ ${children.length - rows.length} more subtasks`));
    }
  } else {
    link(rootX + 202, centerY, resultX, centerY, "var(--green)");
  }
  box(resultX, centerY, 176, task.status === "completed" ? "Task Complete" : "Task Result", task.status === "completed" ? "Result saved" : statusLabel(task.status), { icon: task.status === "completed" ? "✓" : "…", color: "var(--green)", state: task.status });
  root.append(graph, node("span", "flow-hint", "Select an agent node to view its profile"));
  graph.addEventListener("click", event => {
    const target = event.target.closest("[data-agent]");
    if (!target?.dataset.agent) return;
    state.agentId = target.dataset.agent;
    state.detail = "agent";
    render();
  });
  graph.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest("[data-agent]");
    if (!target?.dataset.agent) return;
    event.preventDefault();
    state.agentId = target.dataset.agent;
    state.detail = "agent";
    render();
  });
}

function renderTaskList() {
  const list = $("#task-list");
  const items = roots();
  $("#task-total").textContent = items.length;
  list.replaceChildren();
  items.slice(0, 30).forEach((task, index) => {
    const button = node("button", `task-item${task.id === state.taskId ? " selected" : ""}`);
    button.type = "button";
    button.dataset.task = task.id;
    const title = node("span", "task-index", `#${String(items.length - index).padStart(2, "0")}`);
    const copy = node("span", "task-copy");
    copy.append(node("strong", "", task.title || "Untitled task"), node("small", "", task.agent_id ? agentFor(task.agent_id)?.name || task.agent_id : "Agent task"));
    button.append(title, copy, node("span", `task-state ${task.status === "active" ? "active" : ""}`, statusLabel(task.status)));
    button.addEventListener("click", () => { state.taskId = task.id; state.detail = "task"; state.section = "tasks"; render(); });
    list.append(button);
  });
  if (!items.length) list.append(node("div", "sidebar-empty", "No tasks recorded yet."));
}
function renderAgents() {
  const list = $("#agent-list");
  list.replaceChildren();
  $("#agent-total").textContent = agents().length;
  const recentTaskAgentIds = new Set(tasks().filter(task => task.status === "active").map(task => task.agent_id));
  agents().forEach(agent => {
    const button = node("button", `agent-item${state.agentId === agent.id && state.detail === "agent" ? " selected" : ""}`);
    button.type = "button";
    button.style.setProperty("--agent-color", agentColor(agent.id));
    const avatar = node("span", "agent-avatar", initials(agent.name));
    const copy = node("span", "agent-copy");
    copy.append(node("strong", "", agent.name), node("small", "", agent.description || agent.layaProfile || "Specialist agent"));
    button.append(avatar, copy, node("i", `presence${recentTaskAgentIds.has(agent.id) ? " active" : ""}`));
    button.addEventListener("click", () => { state.agentId = agent.id; state.detail = "agent"; render(); });
    list.append(button);
  });
}
function renderHeader(task) {
  const rootsList = roots();
  const number = Math.max(0, rootsList.findIndex(item => item.id === task?.id));
  $("#task-number").textContent = task ? `#${String(rootsList.length - number).padStart(2, "0")}` : "—";
  $("#task-title").textContent = task?.title || "No tasks yet";
  $("#task-description").textContent = task?.description || "Start a conversation with an agent to see its work here.";
  const status = $("#task-status");
  status.textContent = task ? statusLabel(task.status) : "Idle";
  status.className = `status-pill ${task?.status || "pending"}`;
  $("#task-started").textContent = task ? `Started ${formatDate(task.created_at)}` : "Waiting for the first task";
  const tags = $("#task-tags");
  tags.replaceChildren();
  for (const tag of [task?.agent_id && agentFor(task.agent_id)?.layaProfile, task?.depth ? `Depth ${task.depth}` : null, task?.status]) {
    if (tag) tags.append(node("span", "task-tag", tag));
  }
}

function renderPlan(task) {
  const root = $("#plan-content");
  root.replaceChildren();
  const plans = taskPlans(task);
  root.append(sectionHeading("Task plan", plans.length ? `${plans.length} saved plan${plans.length === 1 ? "" : "s"}` : "Persisted plan steps for this task"));
  if (!plans.length) { root.append(node("div", "empty-state", "No plan has been saved for this task.")); return; }
  const list = node("div", "content-list");
  plans.forEach(plan => {
    const card = node("article", "secondary-card");
    card.append(node("h3", "", plan.objective || "Plan"));
    card.append(node("p", "", `${statusLabel(plan.status)} · ${plan.steps.length} steps`));
    const steps = node("div", "check-list");
    plan.steps.forEach((step, index) => {
      const row = node("div", `check-item${step.status === "completed" ? " done" : ""}`);
      row.append(node("i", "", step.status === "completed" ? "✓" : String(index + 1)), node("span", "", step.description));
      steps.append(row);
    });
    card.append(steps);
    list.append(card);
  });
  root.append(list);
}
function sectionHeading(title, subtitle) {
  const header = node("header", "section-heading");
  const copy = node("div");
  copy.append(node("h2", "", title), node("p", "", subtitle));
  header.append(copy);
  return header;
}
function renderFiles(task) {
  const root = $("#files-content");
  root.replaceChildren();
  const files = fileEntries(task);
  root.append(sectionHeading("Files changed", `${files.length} workspace file${files.length === 1 ? "" : "s"} recorded by write_file`));
  if (!files.length) { root.append(node("div", "empty-state", "File changes appear here when an agent writes a workspace file.")); return; }
  const list = node("div", "content-list");
  files.forEach(file => {
    const row = node("article", "content-row");
    row.append(node("span", "row-icon", "⌘"));
    const copy = node("div");
    copy.append(node("strong", "", file.path), node("small", "", `${agentFor(file.agentId)?.name || file.agentId} · ${formatDate(file.updatedAt)} · ${file.size.toLocaleString()} chars`));
    row.append(copy);
    list.append(row);
  });
  root.append(list);
}
function renderTimeline(task) {
  const root = $("#timeline-content");
  root.replaceChildren();
  const events = activityEvents(task).reverse();
  root.append(sectionHeading("Task timeline", `${events.length} recorded events`));
  if (!events.length) { root.append(node("div", "empty-state", "Routing, retrieval, tool, and agent handoff events will appear here.")); return; }
  const list = node("div", "content-list");
  events.forEach(event => {
    const row = node("article", "content-row");
    row.append(node("span", "row-icon", event.type === "tool" ? "⚒" : event.type === "message" ? "↗" : "·"));
    const copy = node("div");
    copy.append(node("strong", "", `${agentFor(event.agentId)?.name || event.agentId || "Runtime"} · ${event.kind}`), node("small", "", `${formatDate(event.time)} · ${event.text}`));
    row.append(copy);
    list.append(row);
  });
  root.append(list);
}
function renderMetrics(task) {
  const root = $("#metrics-content");
  root.replaceChildren();
  const ids = relatedTaskIds(task);
  const traces = (state.snapshot.traces || []).filter(trace => ids.has(trace.task_id));
  const runs = (state.snapshot.toolRuns || []).filter(run => ids.has(run.taskId));
  const children = Math.max(0, ids.size - (task ? 1 : 0));
  root.append(sectionHeading("Task metrics", "Values collected from runtime traces and SQLite records"));
  const grid = node("div", "secondary-grid");
  [["Agent tasks", ids.size], ["Tool calls", runs.length], ["Trace events", traces.length], ["Files changed", fileEntries(task).length]].forEach(([label, value]) => {
    const card = node("article", "secondary-card");
    card.append(node("p", "", label), node("h3", "", value));
    grid.append(card);
  });
  root.append(grid);
  if (!children && task) root.append(node("p", "", "No delegated subtasks are recorded for this task."));
}
function renderViews(task) {
  $("#flow-view").classList.toggle("hidden", state.view !== "flow");
  $("#plan-view").classList.toggle("hidden", state.view !== "plan");
  $("#files-view").classList.toggle("hidden", state.view !== "files");
  $("#timeline-view").classList.toggle("hidden", state.view !== "timeline");
  $("#metrics-view").classList.toggle("hidden", state.view !== "metrics");
  document.querySelectorAll(".workspace-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === state.view));
  drawFlow(task);
  renderPlan(task);
  renderFiles(task);
  renderTimeline(task);
  renderMetrics(task);
}

function renderActivity(task) {
  const list = $("#activity-list");
  list.replaceChildren();
  let events = activityEvents(task);
  if (state.filter === "chat") events = events.filter(event => event.type === "message");
  else if (state.filter === "tools") events = events.filter(event => event.type === "tool" || event.kind === "tool");
  else if (state.filter === "files") events = events.filter(event => event.type === "tool" && event.raw.name === "write_file");
  else if (state.filter === "logs") events = events.filter(event => event.kind === "error" || event.type === "trace");
  $("#activity-count").textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  if (!events.length) { list.append(node("div", "activity-empty", "No activity recorded for this task yet.")); return; }
  events.slice(-100).reverse().forEach(event => {
    const row = node("div", "activity-row");
    row.append(node("time", "activity-time", formatTime(event.time)));
    const avatar = node("span", "activity-avatar", initials(agentFor(event.agentId)?.name || event.agentId || "RT"));
    avatar.style.setProperty("--agent-color", agentColor(event.agentId));
    row.append(avatar);
    const agent = node("span", "activity-agent", agentFor(event.agentId)?.name || event.agentId || "Runtime");
    agent.style.setProperty("--agent-color", agentColor(event.agentId));
    row.append(agent, node("span", "activity-message", event.text));
    const action = node("span", "activity-action");
    if (event.type === "tool") {
      action.append(node("span", "", event.raw.name || "Tool"), node("span", event.raw.status === "failed" ? "" : "ok", event.raw.status === "failed" ? "!" : "✓"));
    } else if (event.type === "trace") action.append(node("span", "", event.kind));
    else action.append(node("span", "", event.kind));
    row.append(action);
    row.title = event.text;
    list.append(row);
  });
}

function renderTaskDetails(task) {
  const root = $("#details-content");
  root.replaceChildren();
  document.querySelectorAll(".detail-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.detail === state.detail));
  if (state.detail === "agent") { renderAgentDetails(root); return; }
  if (state.detail === "files") { renderFileDetails(root, task); return; }
  if (!task) { root.append(node("div", "empty-state", "Task details will appear after a task starts.")); return; }
  const section = node("section", "detail-section");
  const heading = node("div", "detail-heading");
  heading.append(node("span", "", "Description"));
  section.append(heading, node("p", "detail-description", task.description || task.title));
  root.append(section);
  const fields = node("section", "detail-section");
  fields.append(node("div", "detail-heading", "Task information"));
  [["Status", statusLabel(task.status)], ["Priority", Number(task.priority) > 0 ? `P${task.priority}` : "Normal"], ["Created", formatDate(task.created_at)], ["Updated", formatDate(taskUpdatedAt(task))], ["Owner", agentFor(task.agent_id)?.name || task.agent_id || "—"]].forEach(([label, value]) => {
    const row = node("div", "detail-field"); row.append(node("span", "", label), node("strong", "", value)); fields.append(row);
  });
  root.append(fields);
  if (task.result) {
    const result = node("section", "detail-section");
    result.append(node("div", "detail-heading", "Latest result"), node("p", "detail-description", String(task.result).slice(0, 1800)));
    root.append(result);
  }
  const linked = relatedTasks(task);
  const assigneeIds = [...new Set(linked.map(item => item.agent_id).filter(Boolean))];
  const assignees = node("section", "detail-section");
  assignees.append(node("div", "detail-heading", `Assignees (${assigneeIds.length})`));
  const cards = node("div", "assignee-grid");
  assigneeIds.forEach(id => {
    const agent = agentFor(id); const card = node("div", "assignee-card");
    const avatar = node("span", "agent-avatar", initials(agent?.name || id)); avatar.style.setProperty("--agent-color", agentColor(id));
    card.append(avatar, node("span", "", agent?.name || id)); cards.append(card);
  });
  if (!assigneeIds.length) cards.append(node("span", "sidebar-empty", "No agent assigned"));
  assignees.append(cards); root.append(assignees);
  const plan = taskPlans(task).at(-1);
  const progressItems = plan?.steps || linked.filter(item => item.id !== task.id).map(item => ({ description: item.title, status: item.status }));
  const completed = progressItems.filter(item => item.status === "completed").length;
  const hasProgress = task.status === "completed" || progressItems.length > 0;
  const percent = task.status === "completed" ? 100 : progressItems.length ? Math.round(completed / progressItems.length * 100) : 0;
  const progress = node("section", "detail-section");
  const label = node("div", "progress-label"); label.append(node("span", "", "Progress"), node("strong", "", hasProgress ? `${percent}%` : "Untracked"));
  const track = node("div", "progress-track"), fill = node("i"); fill.style.width = `${percent}%`; track.append(fill);
  progress.append(label);
  if (hasProgress) progress.append(track);
  if (progressItems.length) {
    const checklist = node("div", "check-list");
    progressItems.slice(0, 8).forEach(item => { const row = node("div", `check-item${item.status === "completed" ? " done" : ""}`); row.append(node("i", "", item.status === "completed" ? "✓" : "○"), node("span", "", item.description)); checklist.append(row); });
    progress.append(checklist);
  } else progress.append(node("p", "detail-description", "No plan steps or delegated subtasks are recorded."));
  root.append(progress);
  const files = fileEntries(task);
  const fileSection = node("section", "detail-section");
  fileSection.append(node("div", "detail-heading", `Files Changed (${files.length})`));
  files.slice(0, 5).forEach(file => fileSection.append(fileChangeRow(file)));
  if (!files.length) fileSection.append(node("p", "detail-description", "No file writes recorded."));
  root.append(fileSection);
  const terms = new Set(String(`${task.title || ""} ${task.description || ""}`).toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || []);
  const knowledge = (state.snapshot.knowledge || []).filter(item => [...terms].some(term => `${item.source} ${item.predicate} ${item.target}`.toLowerCase().includes(term))).slice(0, 4);
  if (knowledge.length) {
    const facts = node("section", "detail-section"); facts.append(node("div", "detail-heading", "Related Knowledge (JEV)"));
    knowledge.forEach(item => facts.append(node("p", "detail-description", `${item.source} · ${item.predicate} · ${item.target}`)));
    root.append(facts);
  }
}
function fileChangeRow(file) {
  const row = node("div", "file-change");
  row.append(node("span", "", "▧"), node("code", "", file.path), node("small", "", "Saved"));
  row.title = `${file.path} · ${agentFor(file.agentId)?.name || file.agentId || "Agent"}`;
  return row;
}
function renderAgentDetails(root) {
  const agent = agentFor(state.agentId) || agents()[0];
  if (!agent) { root.append(node("div", "empty-state", "No agents are configured.")); return; }
  const section = node("section", "detail-section");
  const heading = node("div", "detail-heading", "Agent profile");
  const avatar = node("span", "agent-avatar", initials(agent.name)); avatar.style.setProperty("--agent-color", agentColor(agent.id));
  const title = node("div", "assignee-card"); title.style.marginBottom = "10px"; title.append(avatar, node("span", "", agent.name));
  section.append(heading, title, node("p", "detail-description", agent.description || "Specialist agent"));
  root.append(section);
  const policy = node("section", "detail-section"); policy.append(node("div", "detail-heading", "Decision policy"));
  [["Profile", agent.layaProfile || "general"], ["Runtime", agent.n8nLinkId ? "n8n" : agent.socketLinkId ? "WebSocket" : "Local"], ["Can delegate", agent.canDelegate ? "Yes" : "No"]].forEach(([key, value]) => { const row = node("div", "detail-field"); row.append(node("span", "", key), node("strong", "", value)); policy.append(row); });
  root.append(policy);
  const skills = node("section", "detail-section"); skills.append(node("div", "detail-heading", "Skills"));
  const chips = node("div", "skill-list"); (agent.skills || []).forEach(skill => chips.append(node("span", "skill-chip", skill))); skills.append(chips); root.append(skills);
  const owned = tasks().filter(task => task.agent_id === agent.id).length;
  const recent = (state.snapshot.traces || []).filter(trace => trace.agent_id === agent.id).length;
  const stats = node("section", "detail-section"); stats.append(node("div", "detail-heading", "Runtime activity"));
  [["Tasks", owned], ["Recent traces", recent]].forEach(([key, value]) => { const row = node("div", "detail-field"); row.append(node("span", "", key), node("strong", "", value)); stats.append(row); }); root.append(stats);
}
function renderFileDetails(root, task) {
  const files = fileEntries(task);
  const section = node("section", "detail-section");
  section.append(node("div", "detail-heading", `File Changes (${files.length})`));
  section.append(node("p", "detail-description", "Workspace writes recorded for the selected task."));
  root.append(section);
  if (!files.length) { root.append(node("div", "empty-state", "No file changes recorded.")); return; }
  files.forEach(file => {
    const row = node("section", "detail-section");
    row.append(node("div", "detail-heading", file.path));
    row.append(node("p", "detail-description", `${agentFor(file.agentId)?.name || file.agentId} · ${formatDate(file.updatedAt)} · ${file.size.toLocaleString()} characters`));
    root.append(row);
  });
}

function renderSecondaryPage() {
  const page = $("#secondary-page");
  page.replaceChildren();
  const title = ({ agents: "Agents", knowledge: "Knowledge (JEV)", memory: "Memory", tools: "Tools", settings: "Runtime Settings" })[state.section];
  const subtitle = ({ agents: "Configured specialists and their capabilities.", knowledge: "Active entities and relations stored in SQLite.", memory: "Recent durable memory records available to agents.", tools: "Recorded tool activity for recent tasks.", settings: "Live status from the extension runtime." })[state.section];
  const heading = node("header", "secondary-heading"); heading.append(node("h2", "", title), node("p", "", subtitle)); page.append(heading);
  const grid = node("div", "secondary-grid");
  if (state.section === "agents") agents().forEach(agent => {
    const card = node("article", "secondary-card"); card.style.borderTopColor = agentColor(agent.id);
    card.append(node("h3", "", agent.name), node("p", "", agent.description || "Specialist agent"));
    const chips = node("div", "skill-list"); (agent.skills || []).forEach(skill => chips.append(node("span", "skill-chip", skill))); card.append(chips); grid.append(card);
  });
  else if (state.section === "knowledge") (state.snapshot.knowledge || []).forEach(item => {
    const card = node("article", "secondary-card"); card.append(node("h3", "", item.source), node("p", "", `${item.predicate} → ${item.target}`), node("p", "", `Confidence ${Math.round((Number(item.confidence) || 0) * 100)}% · ${formatDate(item.created_at)}`)); grid.append(card);
  });
  else if (state.section === "memory") (state.snapshot.memories || []).forEach(memory => {
    const card = node("article", "secondary-card"); card.append(node("h3", "", memory.type), node("p", "", memory.content), node("p", "", `${agentFor(memory.agent_id)?.name || (memory.agent_id ? memory.agent_id : "Shared memory")} · ${formatDate(memory.created_at)}`)); grid.append(card);
  });
  else if (state.section === "tools") (state.snapshot.toolRuns || []).forEach(run => {
    const card = node("article", "secondary-card"); const args = parseToolArgs(run.arguments);
    card.append(node("h3", "", run.name), node("p", "", `${agentFor(run.agentId)?.name || run.agentId} · ${run.status} · ${formatDate(run.createdAt)}`));
    if (args.path) card.append(node("p", "", args.path));
    card.append(node("p", "", String(run.result || "").slice(0, 240))); grid.append(card);
  });
  else if (state.section === "settings") {
    const laya = state.snapshot.laya || {};
    [["SQLite", "Connected"], ["Laya", laya.connected ? "Connected" : laya.lastError ? "Fallback active" : "Not checked"], ["Tasks", tasks().length], ["Recent tool runs", (state.snapshot.toolRuns || []).length], ["Queue", (state.snapshot.queue || []).map(item => `${item.label}: ${item.status}`).join(" · ") || "No queued work"]].forEach(([label, value]) => { const card = node("article", "secondary-card"); card.append(node("h3", "", label), node("p", "", value)); grid.append(card); });
  }
  if (!grid.childElementCount) grid.append(node("div", "empty-state", "Nothing has been recorded in this section yet."));
  page.append(grid);
}
function renderSection() {
  const secondary = !["overview", "tasks"].includes(state.section);
  $("#secondary-page").classList.toggle("hidden", !secondary);
  $(".center-column").classList.toggle("hidden", secondary);
  $(".details-pane").classList.toggle("hidden", secondary);
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.section === state.section));
  if (secondary) renderSecondaryPage();
}
function renderStatus() {
  const snapshot = state.snapshot;
  const activeTasks = tasks().filter(task => task.status === "active").length;
  const status = snapshot.laya || {};
  $("#status-agent").textContent = `Agents: ${agents().length}`;
  $("#status-tasks").textContent = `Tasks: ${activeTasks} active`;
  $("#status-laya").textContent = `Laya: ${status.connected ? "online" : status.lastError ? "fallback" : "not checked"}`;
  $("#workspace-name").replaceChildren(document.createTextNode(snapshot.workspace || "No workspace"), node("span", "", "⌄"));
  $("#sidebar-status").textContent = status.connected ? "Laya connected · SQLite ready" : status.lastError ? "Laya fallback · SQLite ready" : "SQLite runtime connected";
  $("#laya-dot").classList.toggle("offline", Boolean(status.lastError && !status.connected));
}
function render() {
  const task = selectedTask();
  if (task && state.taskId !== task.id) state.taskId = task.id;
  renderAgents();
  renderTaskList();
  renderHeader(task);
  renderViews(task);
  renderActivity(task);
  renderTaskDetails(task);
  renderSection();
  renderStatus();
}

document.querySelectorAll(".workspace-tab").forEach(tab => tab.addEventListener("click", () => { state.view = tab.dataset.view; render(); }));
document.querySelectorAll(".activity-tab").forEach(tab => tab.addEventListener("click", () => {
  state.filter = tab.dataset.filter;
  document.querySelectorAll(".activity-tab").forEach(item => item.classList.toggle("active", item === tab));
  renderActivity(selectedTask());
}));
document.querySelectorAll(".detail-tab").forEach(tab => tab.addEventListener("click", () => {
  state.detail = tab.dataset.detail;
  document.querySelectorAll(".detail-tab").forEach(item => item.classList.toggle("active", item === tab));
  renderTaskDetails(selectedTask());
}));
document.querySelectorAll(".nav-item").forEach(tab => tab.addEventListener("click", () => { state.section = tab.dataset.section; render(); }));
$("#refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
$("#workspace-name").addEventListener("click", () => vscode.postMessage({ type: "openWorkspace" }));
window.addEventListener("message", event => {
  if (event.data?.type !== "snapshot") return;
  state.snapshot = event.data.value || {};
  if (!state.taskId || !tasks().some(task => task.id === state.taskId)) state.taskId = roots()[0]?.id || "";
  if (!state.agentId) state.agentId = agents()[0]?.id || "";
  render();
});
vscode.postMessage({ type: "ready" });
