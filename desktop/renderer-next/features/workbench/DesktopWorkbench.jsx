"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { call, setUiHandler } from "@webview/bridge";
import { Icon } from "@webview/icons";
import { useData } from "@webview/useData";
import { SidebarApp } from "@webview/sidebar/SidebarApp";
import { OverviewApp } from "@webview/overview/OverviewApp";
import { TaskApp } from "@webview/task/TaskApp";

/**
 * Desktop shell around the extension's own React surfaces (webview-ui): the sidebar,
 * the Overview and one tab per task. Data comes from the Electron main process through
 * the same view-model code the extension uses; ui.* intents are handled here.
 */
const SHELL_STATE_KEY = "agent-workbench.shell";
const OVERVIEW = "overview";

const editorUrl = hash => `${window.location.protocol === "file:" ? "./editor.html" : "/editor"}${hash ? `#${hash}` : ""}`;
/** Chat, files, terminals, agent profiles and settings live on the editor page. */
const openInEditor = hash => { window.location.href = editorUrl(hash); };

function readShellState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHELL_STATE_KEY) || "null");
    if (saved && Array.isArray(saved.tabs)) return { tabs: saved.tabs.filter(tab => typeof tab?.id === "string"), active: String(saved.active || OVERVIEW) };
  } catch { /* storage unavailable or corrupt */ }
  return { tabs: [], active: OVERVIEW };
}

export default function DesktopWorkbench() {
  const [shell, setShell] = useState(readShellState);
  const [toast, setToast] = useState("");
  const [toolRun, setToolRun] = useState(null);
  const [runDialog, setRunDialog] = useState(false);
  const toastTimer = useRef();

  useEffect(() => {
    try { localStorage.setItem(SHELL_STATE_KEY, JSON.stringify(shell)); } catch { /* keep state in memory only */ }
  }, [shell]);

  useEffect(() => {
    document.documentElement.dataset.platform = window.workbench?.platform || "web";
    window.workbench?.getSettings?.().then(settings => {
      document.documentElement.dataset.colorTheme = settings?.colorTheme === "dark" ? "dark" : "light";
    }).catch(() => {});
  }, []);

  const notify = useCallback(message => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  const openTask = useCallback(async taskId => {
    let label = "Task";
    try { label = `Task #${(await call("task.get", { taskId })).task.number}`; } catch { /* the tab shows the error itself */ }
    setShell(current => ({
      tabs: current.tabs.some(tab => tab.id === taskId) ? current.tabs.map(tab => tab.id === taskId ? { ...tab, label } : tab) : [...current.tabs, { id: taskId, label }],
      active: taskId
    }));
  }, []);
  const closeTab = id => setShell(current => {
    const index = current.tabs.findIndex(tab => tab.id === id);
    const tabs = current.tabs.filter(tab => tab.id !== id);
    const active = current.active !== id ? current.active : tabs[Math.min(index, tabs.length - 1)]?.id || OVERVIEW;
    return { tabs, active };
  });
  const showOverview = () => setShell(current => ({ ...current, active: OVERVIEW }));
  const testLaya = useCallback(async () => {
    notify("Testing Laya…");
    const result = await window.workbench.testLaya();
    notify(result.ok ? `Laya answered${result.model ? ` (${result.model})` : ""}.` : `Laya: ${result.error} Set it up in Settings.`);
  }, [notify]);
  const openLatestTask = useCallback(async () => {
    const { taskId } = await call("task.latest", {});
    if (taskId) await openTask(taskId);
    else notify("No agent tasks yet. Run one to see it here.");
  }, [notify, openTask]);

  useEffect(() => {
    setUiHandler(async (method, params) => {
      switch (method) {
        case "ui.openTask": await openTask(params.taskId); break;
        case "ui.openConversation": openInEditor(`conversation=${encodeURIComponent(params.conversationId)}`); break;
        case "ui.openFile": openInEditor(`file=${encodeURIComponent(params.path)}`); break;
        case "ui.openTerminal": openInEditor("terminal"); break;
        case "ui.chatWithAgent": openInEditor(`chat=${encodeURIComponent(params.agentId)}`); break;
        case "ui.showToolRun":
          try { setToolRun(await window.workbench.workbenchRpc("toolRun.get", { toolRunId: params.toolRunId })); }
          catch (error) { notify(error?.message || "Tool run not found."); }
          break;
        case "ui.command":
          if (params.command === "newTask") setRunDialog(true);
          else if (params.command === "newChat") openInEditor("chat");
          else if (params.command === "manageAgents") openInEditor("agents");
          else await testLaya();
          break;
        case "ui.navigate":
          if (params.target === OVERVIEW) showOverview();
          else if (params.target === "tasks") await openLatestTask();
          else if (params.target === "agents") openInEditor("agents");
          else if (params.target === "settings") openInEditor("settings");
          else notify(`The ${params.target === "knowledge" ? "Knowledge (JEV)" : params.target === "memory" ? "Memory" : "Tools"} view is not built yet.`);
          break;
      }
      return null;
    });
    return () => setUiHandler(undefined);
  }, [notify, openLatestTask, openTask, testLaya]);

  const runTask = async prompt => {
    setRunDialog(false);
    // The orchestrator's root task id arrives with its first event; open that task as soon as it exists.
    let opened = false;
    const stop = window.workbench.onAgentEvent(event => {
      if (opened || !event?.rootTaskId) return;
      opened = true;
      stop();
      void openTask(event.rootTaskId);
    });
    try { await window.workbench.runTask({ prompt, agentId: "lead", title: prompt.split(/\r?\n/)[0].slice(0, 120) }); }
    catch (error) { notify(error?.message || "The task could not run."); }
    finally { if (!opened) stop(); }
  };

  const activeTab = shell.tabs.find(tab => tab.id === shell.active);
  return (
    <div className="desk-shell">
      <TitleBar />
      <div className="desk-body">
        <nav className="desk-activity" aria-label="Activity bar">
          <button type="button" className="selected" title="Agent Orchestration" aria-current="page"><Icon name="agents" size={24} /></button>
          <button type="button" title="Explorer and editor" onClick={() => openInEditor("")}><Icon name="file" size={24} /></button>
          <button type="button" title="Agent chat" onClick={() => openInEditor("chat")}><Icon name="chat" size={24} /></button>
          <button type="button" title="Terminal" onClick={() => openInEditor("terminal")}><Icon name="terminal" size={24} /></button>
          <span className="desk-activity-fill" />
          <button type="button" title="Settings" onClick={() => openInEditor("settings")}><Icon name="settings" size={24} /></button>
        </nav>
        <aside className="desk-sidebar" aria-label="Agent Orchestration">
          <header className="desk-view-title">
            <span>Agent Orchestration</span>
            <button type="button" className="icon-button small" title="Run task" aria-label="Run task" onClick={() => setRunDialog(true)}><Icon name="add" size={14} /></button>
            <button type="button" className="icon-button small" title="Open overview" aria-label="Open overview" onClick={showOverview}><Icon name="overview" size={14} /></button>
            <button type="button" className="icon-button small" title="Open settings" aria-label="Open settings" onClick={() => openInEditor("settings")}><Icon name="settings" size={14} /></button>
          </header>
          <div className="desk-sidebar-body"><SidebarApp /></div>
        </aside>
        <main className="desk-editor">
          <div className="desk-tabs" role="tablist" aria-label="Open views">
            <Tab id={OVERVIEW} label="Overview" icon="overview" active={shell.active === OVERVIEW || !activeTab} onSelect={showOverview} />
            {shell.tabs.map(tab => <Tab key={tab.id} id={tab.id} label={tab.label} icon="tasks" active={tab.id === activeTab?.id} onSelect={() => setShell(current => ({ ...current, active: tab.id }))} onClose={() => closeTab(tab.id)} />)}
          </div>
          <div className="desk-view" role="tabpanel">
            {activeTab ? <TaskApp key={activeTab.id} taskId={activeTab.id} /> : <OverviewApp />}
          </div>
        </main>
      </div>
      <StatusBar onOpenLatestTask={() => void openLatestTask()} onTestLaya={() => void testLaya()} />
      {runDialog && <RunTaskDialog onRun={runTask} onCancel={() => setRunDialog(false)} />}
      {toolRun && <ToolRunDialog run={toolRun} onClose={() => setToolRun(null)} />}
      {toast && <div className="desk-toast" role="status">{toast}</div>}
    </div>
  );
}

function Tab({ id, label, icon, active, onSelect, onClose }) {
  return (
    <div className={`desk-tab ${active ? "active" : ""}`} role="presentation">
      <button type="button" role="tab" id={`tab-${id}`} aria-selected={active} className="desk-tab-label" onClick={onSelect}
        onAuxClick={event => { if (event.button === 1 && onClose) onClose(); }}>
        <Icon name={icon} size={14} />{label}
      </button>
      {onClose && <button type="button" className="desk-tab-close" aria-label={`Close ${label}`} title="Close" onClick={onClose}><Icon name="close" size={14} /></button>}
    </div>
  );
}

function TitleBar() {
  const [workspace, setWorkspace] = useState("");
  useEffect(() => { window.workbench?.currentWorkspace?.().then(result => setWorkspace(result?.root || "")).catch(() => {}); }, []);
  const name = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : "No folder open";
  const pick = async () => {
    try { setWorkspace((await window.workbench.openWorkspace())?.root || workspace); } catch { /* dialog closed */ }
  };
  return (
    <header className="desk-titlebar">
      <span className="desk-title-mark" aria-hidden="true"><Icon name="agents" size={16} /></span>
      <span className="desk-title-name">Agent Workbench</span>
      <button type="button" className="desk-command-center" title={workspace ? `${workspace} — open another folder` : "Open a folder"} onClick={pick}>
        <Icon name="search" size={14} /><span>{name}</span>
      </button>
      <div className="desk-window-controls" aria-label="Window controls">
        <button type="button" aria-label="Minimize" onClick={() => window.workbench?.minimizeWindow?.()}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg></button>
        <button type="button" aria-label="Maximize or restore" onClick={() => window.workbench?.toggleMaximizeWindow?.()}><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" /></svg></button>
        <button type="button" aria-label="Close" className="close" onClick={() => window.workbench?.closeWindow?.()}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg></button>
      </div>
    </header>
  );
}

/** Mirrors the extension's native status bar items (backend/src/vscode/statusBar.ts). */
function StatusBar({ onOpenLatestTask, onTestLaya }) {
  const { data } = useData(() => call("sidebar.get", {}), { scopes: ["health"] });
  const health = data?.health;
  const laya = health?.laya.status;
  const layaText = laya === "unconfigured" ? "not set" : laya === "unknown" ? "not contacted" : laya || "…";
  return (
    <footer className="desk-statusbar">
      <span className="desk-status-item"><Icon name="file" size={14} />{health?.workspace || "No workspace"}</span>
      <span className="desk-status-fill" />
      <span className="desk-status-item" title={health?.agentsRunning ? `${health.agentsRunning} agent(s) are working right now.` : "No agent is working right now."}><Icon name="agents" size={14} />Agents: {health?.agentsRunning ?? 0} running</span>
      <button type="button" className="desk-status-item" title="Open the latest task" onClick={onOpenLatestTask}><Icon name="tasks" size={14} />Tasks: {health?.tasksActive ?? 0} active</button>
      <button type="button" className={`desk-status-item ${laya === "offline" ? "warn" : ""}`} title={laya === "offline" ? `Laya is unreachable; decisions use the fallback.\n${health?.laya.lastError ?? ""}` : laya === "unconfigured" ? "No Laya endpoint is set. Add one in Settings." : "Click to test the Laya connection."} onClick={onTestLaya}><Icon name="knowledge" size={14} />Laya: {layaText}</button>
      <span className={`desk-status-item ${health?.sqlite.status === "error" ? "warn" : ""}`} title={health?.sqlite.error || "The runtime database is open."}><Icon name="memory" size={14} />SQLite: {health?.sqlite.status || "…"}</span>
    </footer>
  );
}

function RunTaskDialog({ onRun, onCancel }) {
  const [prompt, setPrompt] = useState("");
  const submit = event => { event.preventDefault(); if (prompt.trim()) onRun(prompt.trim()); };
  return (
    <div className="desk-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <form className="desk-modal" role="dialog" aria-modal="true" aria-labelledby="run-task-title" onSubmit={submit}
        onKeyDown={event => { if (event.key === "Escape") onCancel(); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit(event); }}>
        <h2 id="run-task-title">Run task</h2>
        <p className="muted">The lead agent plans the work and delegates to the team. Progress appears in the task tab.</p>
        <textarea autoFocus rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="What should the agents do?" aria-label="Task instructions" />
        <div className="desk-modal-actions">
          <span className="muted small">Ctrl+Enter to run</span>
          <button type="button" className="button secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button primary" disabled={!prompt.trim()}>Run task</button>
        </div>
      </form>
    </div>
  );
}

function ToolRunDialog({ run, onClose }) {
  return (
    <div className="desk-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="desk-modal wide" role="dialog" aria-modal="true" aria-labelledby="tool-run-title" onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
        <h2 id="tool-run-title">{run.tool} <span className="muted small">· {run.agent} · {run.status}</span></h2>
        <pre className="desk-json">{JSON.stringify(run, null, 2)}</pre>
        <div className="desk-modal-actions"><span /><button type="button" className="button primary" autoFocus onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
