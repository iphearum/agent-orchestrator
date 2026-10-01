import { useState, type ReactNode } from "react";
import type { NavTarget } from "@shared/protocol";
import { call, loadUiState, saveUiState } from "../bridge";
import { Avatar, Empty, StatusDot } from "../components";
import { relative, taskStatusLabel } from "../format";
import { Icon, type IconName } from "../icons";
import { useData } from "../useData";

const NAV: Array<{ id: NavTarget; label: string; icon: IconName; ready: boolean }> = [
  { id: "overview", label: "Overview", icon: "overview", ready: true },
  { id: "tasks", label: "Tasks", icon: "tasks", ready: true },
  { id: "agents", label: "Agents", icon: "agents", ready: true },
  { id: "knowledge", label: "Knowledge (JEV)", icon: "knowledge", ready: false },
  { id: "memory", label: "Memory", icon: "memory", ready: false },
  { id: "tools", label: "Tools", icon: "tools", ready: false },
  { id: "settings", label: "Settings", icon: "settings", ready: true }
];

type SectionId = "agents" | "tasks" | "conversations";

export function SidebarApp() {
  const { data, error } = useData(() => call("sidebar.get", {}), { key: "sidebar", scopes: ["agents", "tasks", "health", "conversations"] });
  const [ui, setUi] = useState(() => loadUiState({ nav: "overview" as NavTarget, collapsed: [] as SectionId[] }));
  const update = (patch: Partial<typeof ui>) => {
    const next = { ...ui, ...patch };
    setUi(next);
    saveUiState(next);
  };
  const toggle = (id: SectionId) => update({ collapsed: ui.collapsed.includes(id) ? ui.collapsed.filter(item => item !== id) : [...ui.collapsed, id] });
  const go = (target: NavTarget) => { update({ nav: target }); void call("ui.navigate", { target }); };

  if (error && !data) return <div className="sidebar"><Empty icon="error">Could not load the runtime: {error}</Empty></div>;
  if (!data) return <div className="sidebar"><Empty>Loading…</Empty></div>;

  return (
    <div className="sidebar">
      <nav className="nav-list" aria-label="Agent orchestration views">
        {NAV.map(item => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${ui.nav === item.id ? "selected" : ""}`}
            onClick={() => go(item.id)}
            aria-current={ui.nav === item.id ? "page" : undefined}
            title={item.ready ? undefined : "Not built yet"}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {!item.ready && <span className="soon">soon</span>}
          </button>
        ))}
      </nav>

      <Section id="agents" title="Agents" collapsed={ui.collapsed.includes("agents")} onToggle={toggle} action={{ label: "Manage agents", onClick: () => void call("ui.command", { command: "manageAgents" }) }}>
        {data.agents.length ? data.agents.map(agent => (
          <button key={agent.id} type="button" className="agent-row" onClick={() => void call("ui.chatWithAgent", { agentId: agent.id })} title={`Chat with ${agent.name}`}>
            <Avatar agent={agent} size={30} />
            <span className="agent-copy"><strong>{agent.name}</strong><small>{agent.description}</small></span>
            <StatusDot state={agent.state} name={agent.name} />
          </button>
        )) : <Empty>No agents yet.</Empty>}
      </Section>

      <Section id="tasks" title="Active Tasks" collapsed={ui.collapsed.includes("tasks")} onToggle={toggle} action={{ label: "Run a new task", onClick: () => void call("ui.command", { command: "newTask" }) }}>
        {data.tasks.length ? data.tasks.map(task => {
          const status = taskStatusLabel(task.status, task.running);
          return (
            <button key={task.id} type="button" className="task-row" onClick={() => void call("ui.openTask", { taskId: task.id })} title={task.title}>
              <span className="task-number">#{task.number}</span>
              <span className="task-title">{task.title}</span>
              <span className={`task-status tone-text-${status.tone}`}>{status.label}</span>
            </button>
          );
        }) : <Empty>No tasks yet. Start one with +.</Empty>}
      </Section>

      <Section id="conversations" title="Recent Conversations" collapsed={ui.collapsed.includes("conversations")} onToggle={toggle} action={{ label: "New chat", onClick: () => void call("ui.command", { command: "newChat" }) }}>
        {data.conversations.length ? data.conversations.map(conversation => (
          <button key={conversation.id} type="button" className="conversation-row" onClick={() => void call("ui.openConversation", { conversationId: conversation.id })} title={conversation.title}>
            <Icon name="chat" />
            <span className="conversation-title">{conversation.title}</span>
            <span className="conversation-time">{relative(conversation.updatedAt)}</span>
          </button>
        )) : <Empty>No conversations yet.</Empty>}
      </Section>
    </div>
  );
}

function Section({ id, title, collapsed, onToggle, action, children }: {
  id: SectionId; title: string; collapsed: boolean; onToggle: (id: SectionId) => void; action: { label: string; onClick: () => void }; children: ReactNode;
}) {
  return (
    <section className="side-section" aria-labelledby={`section-${id}`}>
      <header className="side-section-header">
        <button id={`section-${id}`} type="button" className="side-section-toggle" aria-expanded={!collapsed} onClick={() => onToggle(id)}>
          <Icon name="chevron" size={14} className={collapsed ? "" : "rotate-90"} />
          {title}
        </button>
        <button type="button" className="icon-button small" aria-label={action.label} title={action.label} onClick={action.onClick}><Icon name="add" size={14} /></button>
      </header>
      {!collapsed && <div className="side-section-body">{children}</div>}
    </section>
  );
}
