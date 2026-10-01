import { useLayoutEffect, useRef, useState } from "react";
import type { ConversationMessage, FileChangeView, LogEntry, TaskView, ToolRunView, WorkEvent } from "@shared/protocol";
import { call } from "../bridge";
import { AgentChip, Empty, InlineMarkdown, Markdown, Tabs, Toggle } from "../components";
import { clock, duration } from "../format";
import { Icon, toolIcon } from "../icons";
import { FilesList } from "./FlowPanel";
import { ConversationList } from "./BottomPanels";

export type WorkTab = "work" | "chat" | "tools" | "files" | "logs";

export function WorkPanel({ tab, onTab, task, events, toolRuns, files, logs, messages, groupByAgent, onGroupByAgent, autoScroll, onAutoScroll }: {
  tab: WorkTab; onTab: (tab: WorkTab) => void; task: TaskView; events: WorkEvent[]; toolRuns: ToolRunView[]; files: FileChangeView[];
  logs: LogEntry[]; messages: ConversationMessage[]; groupByAgent: boolean; onGroupByAgent: (value: boolean) => void; autoScroll: boolean; onAutoScroll: (value: boolean) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Stick to the bottom as new rows arrive, but only while the user hasn't scrolled up to read.
  useLayoutEffect(() => {
    const element = body.current;
    if (element && autoScroll && pinned) element.scrollTop = element.scrollHeight;
  }, [events, logs, messages, tab, autoScroll, pinned]);
  const onScroll = () => {
    const element = body.current;
    if (element) setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  };

  return (
    <section className="panel work-panel" aria-label="Agent activity">
      <div className="panel-bar">
        <Tabs label="Agent activity" value={tab} onChange={onTab} tabs={[
          { id: "work", label: "Agent Work" }, { id: "chat", label: "Chat" }, { id: "tools", label: "Tool Calls", count: toolRuns.length || undefined },
          { id: "files", label: "Files" }, { id: "logs", label: "Logs" }
        ]} />
        <span className="spacer" />
        {tab === "work" && <Toggle label="Group by Agent" checked={groupByAgent} onChange={onGroupByAgent} />}
        <label className="checkbox"><input type="checkbox" checked={autoScroll} onChange={event => onAutoScroll(event.target.checked)} /> Auto-scroll</label>
      </div>
      <div className="panel-body scroll" ref={body} onScroll={onScroll} role="tabpanel">
        {tab === "work" && <WorkFeed events={events} groupByAgent={groupByAgent} />}
        {tab === "chat" && <ChatTab task={task} messages={messages} />}
        {tab === "tools" && <ToolCalls runs={toolRuns} />}
        {tab === "files" && <FilesList files={files} />}
        {tab === "logs" && <Logs logs={logs} />}
      </div>
      {!pinned && autoScroll && (
        <button type="button" className="jump-latest" onClick={() => { setPinned(true); }}>Jump to latest</button>
      )}
    </section>
  );
}

function WorkFeed({ events, groupByAgent }: { events: WorkEvent[]; groupByAgent: boolean }) {
  if (!events.length) return <Empty>No agent activity recorded for this task yet.</Empty>;
  if (!groupByAgent) return <div className="feed">{events.map(event => <WorkRow key={event.id} event={event} />)}</div>;
  const groups = new Map<string, WorkEvent[]>();
  for (const event of events) {
    const key = event.agent?.id ?? "system";
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return (
    <div className="feed grouped">
      {[...groups.values()].map(group => (
        <details key={group[0].agent?.id ?? "system"} className="feed-group" open>
          <summary><AgentChip agent={group[0].agent} /><span className="muted">{group.length} event{group.length === 1 ? "" : "s"}</span></summary>
          {group.map(event => <WorkRow key={event.id} event={event} />)}
        </details>
      ))}
    </div>
  );
}

function WorkRow({ event }: { event: WorkEvent }) {
  const openable = event.tool?.ref?.startsWith("tool://");
  const open = () => { if (openable) void call("ui.showToolRun", { toolRunId: event.tool!.ref!.slice("tool://".length) }); };
  return (
    <div className={`feed-row ${openable ? "clickable" : ""}`} onClick={open} role={openable ? "button" : undefined} tabIndex={openable ? 0 : undefined}
      onKeyDown={keyEvent => { if (openable && (keyEvent.key === "Enter" || keyEvent.key === " ")) { keyEvent.preventDefault(); open(); } }}>
      <span className="feed-time">{event.kind === "live" ? "now" : clock(event.at)}</span>
      <span className="feed-agent"><AgentChip agent={event.agent} /></span>
      <span className="feed-label" title={event.label}><InlineMarkdown text={event.label} /></span>
      <span className="feed-tool">{event.tool && <><Icon name={toolIcon(event.tool.name)} size={14} />{event.tool.displayName}</>}</span>
      <span className="feed-status"><EventStatus status={event.status} /></span>
    </div>
  );
}

function EventStatus({ status }: { status: WorkEvent["status"] }) {
  switch (status) {
    case "succeeded": return <Icon name="check" className="tone-text-success" title="Succeeded" />;
    case "failed": return <Icon name="error" className="tone-text-danger" title="Failed" />;
    case "running": return <span className="spinner" role="img" aria-label="Running" />;
    case "pending_approval": return <span className="approval-note" title="Approve or decline in the dialog VS Code is showing"><Icon name="shield" size={14} /> Approval</span>;
    case "task_completed": return <span className="task-completed"><span className="pill-dot" aria-hidden="true" />Task Completed</span>;
    default: return null;
  }
}

function ChatTab({ task, messages }: { task: TaskView; messages: ConversationMessage[] }) {
  return (
    <div className="chat-tab">
      <ConversationList messages={messages} />
      {task.owner && (
        <div className="chat-tab-actions">
          <button type="button" className="button secondary" onClick={() => void (task.conversationId
            ? call("ui.openConversation", { conversationId: task.conversationId })
            : call("ui.chatWithAgent", { agentId: task.owner!.id }))}>
            <Icon name="chat" /> Continue in chat with {task.owner.name}
          </button>
        </div>
      )}
    </div>
  );
}

function ToolCalls({ runs }: { runs: ToolRunView[] }) {
  if (!runs.length) return <Empty icon="tools">No tool calls yet.</Empty>;
  return (
    <table className="data-table">
      <thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th>Status</th><th>Duration</th><th>Result</th></tr></thead>
      <tbody>
        {runs.map(run => (
          <tr key={run.id} className="clickable" tabIndex={0} onClick={() => void call("ui.showToolRun", { toolRunId: run.id })}
            onKeyDown={event => { if (event.key === "Enter") void call("ui.showToolRun", { toolRunId: run.id }); }} title="Open the full arguments and result">
            <td className="mono">{clock(run.createdAt)}</td>
            <td>{run.agentId}</td>
            <td><span className="tool-name"><Icon name={toolIcon(run.toolName)} size={14} />{run.displayName}</span></td>
            <td className={run.status === "failed" ? "tone-text-danger" : "tone-text-success"}>{run.status}</td>
            <td className="mono">{duration(run.durationMs)}</td>
            <td className="ellipsis" title={run.summary}>{run.summary}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Logs({ logs }: { logs: LogEntry[] }) {
  if (!logs.length) return <Empty>No trace entries yet.</Empty>;
  return (
    <div className="logs">
      {logs.map(entry => (
        <details key={entry.id} className="log-line">
          <summary><span className="mono">{clock(entry.at)}</span> <span className="log-kind">{entry.kind}</span> <span className="muted">{entry.agentId}</span> <span className="log-preview">{entry.data.slice(0, 160)}</span></summary>
          <Markdown text={"```json\n" + pretty(entry.data) + "\n```"} />
        </details>
      ))}
    </div>
  );
}

function pretty(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
