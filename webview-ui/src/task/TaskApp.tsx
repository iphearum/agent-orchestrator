import { useEffect, useState } from "react";
import type { FileChangeView, KnowledgeItem, TaskBundle, TaskView, ToolRunView, WorkEvent } from "@shared/protocol";
import { call, loadUiState, onInit, saveUiState } from "../bridge";
import { AgentChip, Avatar, Empty, Pill, Splitter, StatusDot, Tabs, useNarrow } from "../components";
import { agentStateLabel, clock, dateTime, priorityLabel, relative, taskStatusLabel } from "../format";
import { entityIcon, Icon } from "../icons";
import { useData } from "../useData";
import { ConversationCard, CodePanel, TestResultsCard, type CodeTab } from "./BottomPanels";
import { FilesList, FlowPanel, PlanChecklist, type FlowTab } from "./FlowPanel";
import { WorkPanel, type WorkTab } from "./WorkPanel";

type DetailsTab = "task" | "agents" | "files";
/** Pane sizes in pixels; the Work panel and the Agent Conversation card take whatever is left. */
const DEFAULT_SIZES = { detailsWidth: 320, flowHeight: 250, bottomHeight: 240, codeWidth: 520, testsWidth: 250 };
const DEFAULT_UI = { taskId: "", flowTab: "flow" as FlowTab, workTab: "work" as WorkTab, codeTab: "code" as CodeTab, detailsTab: new URLSearchParams(location.search).get("details") === "agents" ? "agents" as DetailsTab : "task" as DetailsTab, groupByAgent: false, autoScroll: true, ...DEFAULT_SIZES };

/** `taskId` is given by the desktop shell; VS Code panels get theirs from the host's init message. */
export function TaskApp({ taskId: fixedTaskId }: { taskId?: string } = {}) {
  const [ui, setUi] = useState(() => loadUiState(DEFAULT_UI));
  const taskId = fixedTaskId || ui.taskId;
  const update = (patch: Partial<typeof ui>) => setUi(current => {
    const next = { ...current, ...patch };
    saveUiState(next);
    return next;
  });
  // The host tells the panel which task it shows; the id is also saved so the panel survives a reload.
  useEffect(() => onInit(init => { if (init.context.taskId) update({ taskId: init.context.taskId }); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const narrow = useNarrow();
  const { data, error, reload } = useData<TaskBundle>(() => call("task.get", { taskId }), { key: `task:${taskId}`, scopes: ["tasks", "agents"], taskId, enabled: Boolean(taskId) });
  if (error && !data) return <div className="task-app"><Empty icon="error">{error}</Empty></div>;
  if (!data) return <div className="task-app"><Empty>Loading task…</Empty></div>;

  // Each handle resizes one pane; double-click (or Enter) puts it back to its default size.
  const splitter = (key: keyof typeof DEFAULT_SIZES, orientation: "vertical" | "horizontal", min: number, max: number, label: string, invert = false) => narrow ? null : (
    <Splitter orientation={orientation} value={ui[key]} min={min} max={max} label={label} invert={invert}
      onChange={value => update({ [key]: value })} onReset={() => update({ [key]: DEFAULT_SIZES[key] })} />
  );
  const wide = !narrow;

  return (
    <div className="task-app" style={wide ? { gridTemplateColumns: `minmax(0, 1fr) 6px ${ui.detailsWidth}px` } : undefined}>
      <div className="task-main" style={wide ? { gridTemplateRows: `auto ${ui.flowHeight}px 10px minmax(120px, 1fr) 10px ${ui.bottomHeight}px` } : undefined}>
        <TaskHeader task={data.task} onChanged={reload} />
        <FlowPanel tab={ui.flowTab} onTab={flowTab => update({ flowTab })} flow={data.flow} task={data.task} files={data.files} events={data.events} metrics={data.metrics} />
        {splitter("flowHeight", "horizontal", 120, 640, "Resize the Agent Flow panel")}
        <WorkPanel
          tab={ui.workTab} onTab={workTab => update({ workTab })} task={data.task} events={data.events} toolRuns={data.toolRuns} files={data.files}
          logs={data.logs} messages={data.messages} groupByAgent={ui.groupByAgent} onGroupByAgent={groupByAgent => update({ groupByAgent })}
          autoScroll={ui.autoScroll} onAutoScroll={autoScroll => update({ autoScroll })}
        />
        {splitter("bottomHeight", "horizontal", 110, 640, "Resize the code, tests and conversation row", true)}
        <div className="bottom-row" style={wide ? { gridTemplateColumns: `minmax(0, ${ui.codeWidth}px) 10px minmax(0, ${ui.testsWidth}px) 10px minmax(240px, 1fr)` } : undefined}>
          <CodePanel tab={ui.codeTab} onTab={codeTab => update({ codeTab })} files={data.files} tests={data.tests} />
          {splitter("codeWidth", "vertical", 200, 1400, "Resize the code changes panel")}
          <TestResultsCard tests={data.tests} />
          {splitter("testsWidth", "vertical", 160, 900, "Resize the test results panel")}
          <ConversationCard messages={data.messages} />
        </div>
      </div>
      {splitter("detailsWidth", "vertical", 220, 640, "Resize the task details column", true)}
      <DetailsColumn tab={ui.detailsTab} onTab={detailsTab => update({ detailsTab })} bundle={data} onChanged={reload} />
    </div>
  );
}

function TaskHeader({ task, onChanged }: { task: TaskView; onChanged: () => void }) {
  const status = taskStatusLabel(task.status, task.running);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const setStatus = async (value: "completed" | "cancelled") => {
    setBusy(true);
    setMenu(false);
    try { await call("task.update", { taskId: task.id, status: value }); setProblem(undefined); onChanged(); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const completeHint = task.running ? "The task is still running." : task.status === "completed" ? "Already done." : task.status === "cancelled" ? "The task was cancelled." : "Mark this task as done";
  return (
    <header className="task-header">
      <div className="task-heading">
        <div className="task-title-line">
          <span className="task-number">#{task.number}</span>
          <h1 title={task.title}>{task.title}</h1>
          <Pill tone={status.tone} icon="dot">{status.label}</Pill>
          {task.priority > 0 && <Pill tone={task.priority >= 2 ? "danger" : "accent"} icon="flag">{priorityLabel(task.priority)}</Pill>}
        </div>
        {task.description !== task.title && <p className="task-description" title={task.description}>{task.description}</p>}
        <p className="task-meta">
          <span>Started <strong>{dateTime(task.createdAt)}</strong></span>
          <span>Updated <strong>{relative(task.updatedAt) || "—"}</strong></span>
          <span>by <strong>{task.createdBy}</strong></span>
        </p>
        <div className="task-tags">
          {task.assignees.map(assignee => <AgentChip key={assignee.agent.id} agent={assignee.agent} />)}
          {task.counts.subtasks > 0 && <span className="chip">{task.counts.subtasks} subtask{task.counts.subtasks === 1 ? "" : "s"}</span>}
          {task.counts.toolRuns > 0 && <span className="chip">{task.counts.toolRuns} tool call{task.counts.toolRuns === 1 ? "" : "s"}</span>}
        </div>
      </div>
      <div className="task-actions">
        {task.status === "completed" || task.status === "cancelled" ? (
          <span className={`closed-state ${task.status}`} title={completeHint}>
            <Icon name={task.status === "completed" ? "check" : "close"} /> {task.status === "completed" ? "Completed" : "Cancelled"}
          </span>
        ) : (
          <button type="button" className="button primary" disabled={!task.canComplete || busy} title={completeHint} onClick={() => void setStatus("completed")}>
            <Icon name="check" /> Complete
          </button>
        )}
        <div className="menu-wrap">
          <button type="button" className="icon-button" aria-label="More task actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>⋮</button>
          {menu && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" disabled={!task.canComplete} onClick={() => void setStatus("cancelled")}>Cancel task</button>
              {task.owner && <button type="button" role="menuitem" onClick={() => { setMenu(false); void call("ui.chatWithAgent", { agentId: task.owner!.id }); }}>Chat with {task.owner.name}</button>}
            </div>
          )}
        </div>
      </div>
      {problem && <p className="inline-error" role="alert">{problem}</p>}
    </header>
  );
}

function DetailsColumn({ tab, onTab, bundle, onChanged }: { tab: DetailsTab; onTab: (tab: DetailsTab) => void; bundle: TaskBundle; onChanged: () => void }) {
  return (
    <aside className="details" aria-label="Task details">
      <div className="details-tabs">
        <Tabs label="Details" variant="underline" value={tab} onChange={onTab} tabs={[
          { id: "task", label: "Task Details" }, { id: "agents", label: "Agent Details" }, { id: "files", label: "File Changes" }
        ]} />
      </div>
      <div className="details-body" role="tabpanel">
        {tab === "task" && <TaskDetails task={bundle.task} files={bundle.files} knowledge={bundle.knowledge} onChanged={onChanged} />}
        {tab === "agents" && <AgentDetails task={bundle.task} events={bundle.events} toolRuns={bundle.toolRuns} />}
        {tab === "files" && <FilesList files={bundle.files} />}
      </div>
    </aside>
  );
}

function TaskDetails({ task, files, knowledge, onChanged }: { task: TaskView; files: FileChangeView[]; knowledge: KnowledgeItem[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const [saving, setSaving] = useState(false);
  const status = taskStatusLabel(task.status, task.running);
  const save = async () => {
    setSaving(true);
    try { await call("task.update", { taskId: task.id, description: draft }); setEditing(false); onChanged(); }
    finally { setSaving(false); }
  };
  const progress = task.plan ? Math.round(task.plan.progress * 100) : undefined;
  return (
    <>
      <section className="detail-section">
        <div className="detail-heading"><h2>Description</h2>{!editing && <button type="button" className="button secondary small" onClick={() => { setDraft(task.description); setEditing(true); }}>Edit</button>}</div>
        {editing ? (
          <div className="edit-box">
            <textarea value={draft} onChange={event => setDraft(event.target.value)} rows={5} aria-label="Task description" />
            <div className="edit-actions">
              <button type="button" className="button primary small" disabled={saving} onClick={() => void save()}>Save</button>
              <button type="button" className="button secondary small" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : <p className="description-text">{task.description}</p>}
        <dl className="props">
          <dt>Status</dt><dd><Pill tone={status.tone} icon="dot">{status.label}</Pill></dd>
          <dt>Priority</dt><dd>{task.priority > 0 ? <Pill tone={task.priority >= 2 ? "danger" : "accent"} icon="flag">{priorityLabel(task.priority)}</Pill> : <span className="muted">Normal</span>}</dd>
          <dt>Owner</dt><dd>{task.owner ? <AgentChip agent={task.owner} /> : "—"}</dd>
          <dt>Created</dt><dd>{dateTime(task.createdAt)}</dd>
          <dt>Updated</dt><dd>{relative(task.updatedAt) || "—"}</dd>
          <dt>Created by</dt><dd>{task.createdBy}</dd>
        </dl>
      </section>

      <section className="detail-section">
        <h2>Assignees</h2>
        {task.assignees.length ? (
          <div className="assignees">
            {task.assignees.map(({ agent, activity }) => (
              <div key={agent.id} className="assignee">
                <Avatar agent={agent} size={24} />
                <span className="assignee-copy"><strong>{agent.name}</strong><small>{activity}</small></span>
                <StatusDot state={agent.state} name={agent.name} />
              </div>
            ))}
          </div>
        ) : <Empty>No agent has picked this up yet.</Empty>}
      </section>

      <section className="detail-section">
        <h2>Progress</h2>
        {progress !== undefined ? (
          <>
            <div className="progress-row">
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Plan progress"><span style={{ width: `${progress}%` }} /></div>
              <span className="progress-value">{progress}%</span>
            </div>
            <PlanChecklist steps={task.plan!.steps} />
          </>
        ) : <p className="muted">No plan yet. Progress appears when an agent creates a plan.</p>}
      </section>

      <section className="detail-section">
        <h2>Files Changed ({files.length})</h2>
        <FilesList files={files} />
      </section>

      <section className="detail-section">
        <h2>Related Knowledge (JEV)</h2>
        {knowledge.length ? (
          <ul className="knowledge-list">
            {knowledge.map(item => (
              <li key={item.id} className="knowledge-item">
                <span className="knowledge-icon"><Icon name={entityIcon(item.type)} /></span>
                <span className="knowledge-copy"><strong>{item.name}</strong><small>{item.type}</small></span>
                <span className="knowledge-count" title={`${item.relationCount} active relations`}><Icon name="knowledge" size={14} />{item.relationCount}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No stored entities match this task yet.</p>}
      </section>
    </>
  );
}

function AgentDetails({ task, events, toolRuns }: { task: TaskView; events: WorkEvent[]; toolRuns: ToolRunView[] }) {
  if (!task.assignees.length) return <Empty>No agents on this task yet.</Empty>;
  return (
    <div className="agent-details">
      {task.assignees.map(({ agent, activity }) => {
        const runs = toolRuns.filter(run => run.agentId === agent.id);
        const last = [...events].reverse().find(event => event.agent?.id === agent.id && event.kind !== "live");
        const failed = runs.filter(run => run.status === "failed").length;
        const lastText = last ? cleanAgentReport(last.label) : "";
        return (
          <section key={agent.id} className="detail-section agent-detail-card">
            <div className="agent-detail-head"><Avatar agent={agent} size={32} /><span className="assignee-copy"><strong>{agent.name}</strong><small>{activity} · {agentStateLabel[agent.state]}</small></span></div>
            <div className="agent-detail-stats" aria-label="Agent activity">
              <span className="agent-stat"><Icon name="tools" size={13} /> {runs.length} tool calls</span>
              {failed > 0 && <span className="agent-stat failed"><Icon name="error" size={13} /> {failed} failed</span>}
            </div>
            {last ? (
              <details className="agent-last-action">
                <summary>
                  <span className="agent-last-label">Latest activity <time>{clock(last.at)}</time></span>
                  <span className="agent-last-preview" title={lastText}>{lastText}</span>
                  <span className="agent-last-toggle">View report</span>
                </summary>
                <p>{lastText}</p>
              </details>
            ) : <p className="agent-no-action">No activity recorded yet.</p>}
            <button type="button" className="button secondary small agent-chat-action" onClick={() => void call("ui.chatWithAgent", { agentId: agent.id })}><Icon name="chat" /> Chat with {agent.name}</button>
          </section>
        );
      })}
    </div>
  );
}

function cleanAgentReport(text: string) {
  return text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\x60([^\x60]+)\x60/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}
