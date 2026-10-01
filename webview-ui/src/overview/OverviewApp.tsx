import { useState } from "react";
import type { OverviewView, TaskBundle } from "@shared/protocol";
import { call } from "../bridge";
import { AgentChip, Avatar, Empty, StatusDot } from "../components";
import { agentStateLabel, clock, relative, taskStatusLabel } from "../format";
import { entityIcon, Icon, toolIcon, type IconName } from "../icons";
import { useData } from "../useData";
import { AgentFlowGraph, PlanChecklist } from "../task/FlowPanel";

/** Workspace dashboard. The Activity Bar sidebar already provides navigation, so this page has none of its own. */
export function OverviewApp() {
  const { data, error } = useData(() => call("overview.get", {}), { scopes: ["agents", "tasks", "health", "conversations"] });
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [flowScale, setFlowScale] = useState(1);
  const [fitFlowRequest, setFitFlowRequest] = useState(0);
  const taskId = selectedTaskId || data?.recentTasks.find(task => task.running)?.id || data?.recentTasks[0]?.id || "";
  const { data: work, error: workError } = useData<TaskBundle>(
    () => call("task.get", { taskId }), { scopes: ["agents", "tasks"], taskId, enabled: Boolean(taskId) }
  );
  if (error && !data) return <div className="overview"><Empty icon="error">Could not load the overview: {error}</Empty></div>;
  if (!data) return <div className="overview"><Empty>Loading…</Empty></div>;

  const working = data.agents.filter(agent => agent.state !== "idle" && agent.state !== "failed").length;
  return (
    <div className="overview">
      <header className="overview-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">{data.health.workspace} · {data.counts.total} task{data.counts.total === 1 ? "" : "s"} · {data.agents.length} agents</p>
        </div>
        <div className="overview-actions">
          <button type="button" className="button secondary" onClick={() => void call("ui.command", { command: "newChat" })}><Icon name="chat" /> New chat</button>
          <button type="button" className="button primary" onClick={() => void call("ui.command", { command: "newTask" })}><Icon name="add" /> Run task</button>
        </div>
      </header>

      <section className="stat-grid" aria-label="Summary">
        <Stat icon="tasks" label="Running now" value={data.counts.running} tone={data.counts.running ? "success" : "muted"} />
        <Stat icon="check" label="Completed" value={data.counts.completed} tone="success" />
        <Stat icon="error" label="Blocked" value={data.counts.blocked} tone={data.counts.blocked ? "danger" : "muted"} note={data.counts.interrupted ? `${data.counts.interrupted} interrupted` : undefined} />
        <Stat icon="agents" label="Agents working" value={working} note={`of ${data.agents.length}`} tone={working ? "success" : "muted"} />
        <Stat icon="tools" label="Tool calls" value={data.toolRuns.total} tone={data.toolRuns.failed ? "warning" : "muted"} note={data.toolRuns.failed ? `${data.toolRuns.failed} failed` : undefined} />
        <Stat icon="knowledge" label="Laya" value={lay(data.health.laya.status)} tone={data.health.laya.status === "online" ? "success" : data.health.laya.status === "offline" || data.health.laya.status === "paused" ? "warning" : "muted"} note={data.health.laya.status === "unconfigured" || data.health.laya.status === "paused" ? "fallback decisions" : undefined} />
      </section>

      <section className="panel overview-card overview-agent-board" aria-labelledby="agent-work-title">
        <div className="panel-bar">
          <span className="panel-title" id="agent-work-title">Agent Work</span>
          <span className="spacer" />
          {data.recentTasks.length > 0 && <select aria-label="Task shown in Agent Work" value={taskId} onChange={event => { setSelectedTaskId(event.target.value); setFlowScale(1); setFitFlowRequest(value => value + 1); }}>
            {data.recentTasks.map(task => <option key={task.id} value={task.id}>#{task.number} · {task.title}</option>)}
          </select>}
          {taskId && <button type="button" className="link-button" onClick={() => void call("ui.openTask", { taskId })}>Open task</button>}
        </div>
        {work && work.task.id === taskId ? (
          <div className="overview-agent-board-body">
            <div className="overview-agent-flow" aria-label={`Agent flow for ${work.task.title}`}>
              <AgentFlowGraph flow={work.flow} scale={flowScale} onScale={setFlowScale} fitRequest={fitFlowRequest} />
            </div>
            <aside className="overview-work-details">
              <section className="overview-work-section">
                <h2>Progress</h2>
                {work.task.plan ? <>
                  <div className="progress-row">
                    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(work.task.plan.progress * 100)} aria-label="Plan progress"><span style={{ width: `${Math.round(work.task.plan.progress * 100)}%` }} /></div>
                    <span className="progress-value">{Math.round(work.task.plan.progress * 100)}%</span>
                  </div>
                  <PlanChecklist steps={work.task.plan.steps} />
                </> : <p className="muted small">No plan yet.</p>}
              </section>
              <section className="overview-work-section overview-work-knowledge">
                <h2>Related Knowledge (JEV)</h2>
                {work.knowledge.length ? <ul className="knowledge-list">
                  {work.knowledge.map(item => <li key={item.id} className="knowledge-item">
                    <span className="knowledge-icon"><Icon name={entityIcon(item.type)} /></span>
                    <span className="knowledge-copy"><strong>{item.name}</strong><small>{item.type}</small></span>
                    <span className="knowledge-count" title={`${item.relationCount} active relations`}><Icon name="knowledge" size={14} />{item.relationCount}</span>
                  </li>)}
                </ul> : <p className="muted small">No related knowledge yet.</p>}
              </section>
            </aside>
          </div>
        ) : <div className="panel-body"><Empty icon={workError ? "error" : "agents"}>{workError ?? (taskId ? "Loading agent work…" : "Run a task to see agent work here.")}</Empty></div>}
      </section>

      <div className="overview-columns">
        <section className="panel overview-card" aria-labelledby="recent-tasks">
          <div className="panel-bar"><span className="panel-title" id="recent-tasks">Recent tasks</span><span className="spacer" /><button type="button" className="link-button" onClick={() => void call("ui.navigate", { target: "tasks" })}>All tasks</button></div>
          <div className="panel-body scroll">
            {data.recentTasks.length ? data.recentTasks.map(task => {
              const status = taskStatusLabel(task.status, task.running);
              return (
                <button key={task.id} type="button" className="overview-task" onClick={() => void call("ui.openTask", { taskId: task.id })}>
                  <span className="task-number">#{task.number}</span>
                  <span className="overview-task-title">{task.title}</span>
                  {task.owner && <AgentChip agent={task.owner} />}
                  <span className={`task-status tone-text-${status.tone}`}>{status.label}</span>
                  <span className="muted small overview-when">{relative(task.updatedAt)}</span>
                </button>
              );
            }) : <Empty icon="tasks">No tasks yet. Run one to see it here.</Empty>}
          </div>
        </section>

        <section className="panel overview-card" aria-labelledby="agent-roster">
          <div className="panel-bar"><span className="panel-title" id="agent-roster">Agents</span><span className="spacer" /><button type="button" className="link-button" onClick={() => void call("ui.command", { command: "manageAgents" })}>Manage</button></div>
          <div className="panel-body scroll">
            {data.agents.map(agent => (
              <button key={agent.id} type="button" className="overview-agent" onClick={() => void call("ui.chatWithAgent", { agentId: agent.id })} title={`Chat with ${agent.name}`}>
                <Avatar agent={agent} size={28} />
                <span className="agent-copy"><strong>{agent.name}</strong><small>{agent.description}</small></span>
                <span className="muted small">{agent.taskCount} task{agent.taskCount === 1 ? "" : "s"}</span>
                <span className="overview-agent-state"><StatusDot state={agent.state} name={agent.name} /><span className="muted small">{agentStateLabel[agent.state]}</span></span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="panel overview-card overview-activity" aria-labelledby="recent-activity">
        <div className="panel-bar"><span className="panel-title" id="recent-activity">Recent activity</span></div>
        <div className="panel-body scroll">
          {data.activity.length ? data.activity.map(event => (
            <div key={event.id} className="overview-event">
              <span className="feed-time">{clock(event.at)}</span>
              <AgentChip agent={event.agent} />
              <span className="feed-label" title={event.label}>{event.label}</span>
              <span className="feed-tool">{event.tool && <><Icon name={toolIcon(event.tool.name)} size={14} />{event.tool.displayName}</>}</span>
              <button type="button" className="link-button" onClick={() => void call("ui.openTask", { taskId: event.taskId })}>#{event.taskNumber}</button>
            </div>
          )) : <Empty>No agent activity yet.</Empty>}
        </div>
      </section>
    </div>
  );
}

function lay(status: OverviewView["health"]["laya"]["status"]) {
  return status === "unconfigured" ? "Not set" : status[0].toUpperCase() + status.slice(1);
}

function Stat({ icon, label, value, note, tone }: { icon: IconName; label: string; value: number | string; note?: string; tone: string }) {
  return (
    <div className={`stat tone-${tone}`}>
      <span className="stat-icon" aria-hidden="true"><Icon name={icon} /></span>
      <span className="stat-copy">
        <span className="stat-label">{label}</span>
        <strong className="stat-value">{value}</strong>
        {note && <small className="muted">{note}</small>}
      </span>
    </div>
  );
}
