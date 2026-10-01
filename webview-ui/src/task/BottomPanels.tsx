import { useState } from "react";
import type { ConversationMessage, FileChangeView, TestReportView } from "@shared/protocol";
import { call } from "../bridge";
import { Avatar, Empty, Markdown, PersonAvatar, Tabs } from "../components";
import { clock } from "../format";
import { Icon } from "../icons";

export type CodeTab = "code" | "terminal" | "tests";

export function CodePanel({ tab, onTab, files, tests }: { tab: CodeTab; onTab: (tab: CodeTab) => void; files: FileChangeView[]; tests: TestReportView | null }) {
  const [selected, setSelected] = useState<string>();
  const file = files.find(item => item.id === selected) ?? files[files.length - 1];
  return (
    <section className="panel code-panel" aria-label="Code, terminal and tests">
      <div className="panel-bar">
        <Tabs label="Code, terminal and tests" variant="underline" value={tab} onChange={onTab} tabs={[
          { id: "code", label: "Code Changes" }, { id: "terminal", label: "Terminal" }, { id: "tests", label: "Test Results" }
        ]} />
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "code" && (file ? (
          <div className="code-view">
            <div className="code-header">
              {files.length > 1 ? (
                <select aria-label="Changed file" value={file.id} onChange={event => setSelected(event.target.value)}>
                  {files.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}
                </select>
              ) : <span className="mono">{file.path}</span>}
              <span className="spacer" />
              <span className="muted small">written by {file.agentId} · {clock(file.at)}</span>
              <button type="button" className="icon-button" title={`Open ${file.path}`} aria-label={`Open ${file.path}`} onClick={() => void call("ui.openFile", { path: file.path })}><Icon name="external" /></button>
            </div>
            <WrittenContent content={file.content} />
          </div>
        ) : <Empty icon="code">No code changes yet.</Empty>)}
        {tab === "terminal" && (
          <Empty icon="terminal">
            Terminals run in VS Code's own panel.{" "}
            <button type="button" className="link-button" onClick={() => void call("ui.openTerminal", {})}>Open a terminal in this workspace</button>
          </Empty>
        )}
        {tab === "tests" && <TestList tests={tests} />}
      </div>
    </section>
  );
}

/** The write tool records only the new file content, so it is shown as added lines. */
function WrittenContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const shown = lines.slice(0, 400);
  return (
    <div className="code-lines" role="region" aria-label="Written file content">
      {shown.map((line, index) => (
        <div key={index} className="code-line added"><span className="line-no">{index + 1}</span><span className="line-sign">+</span><span className="line-text">{line || " "}</span></div>
      ))}
      {lines.length > shown.length && <div className="code-line more">… {lines.length - shown.length} more lines. Open the file to see everything.</div>}
    </div>
  );
}

function TestList({ tests }: { tests: TestReportView | null }) {
  if (!tests) return <Empty icon="beaker">No test run yet. Test results appear when an agent runs a test command.</Empty>;
  return (
    <div className="test-list">
      <p className="muted mono small">$ {tests.command}</p>
      {tests.cases.length ? tests.cases.map((testCase, index) => (
        <div key={`${testCase.name}-${index}`} className="test-case">
          <Icon name={testCase.status === "passed" ? "check" : "error"} className={testCase.status === "passed" ? "tone-text-success" : "tone-text-danger"} />
          <span className="test-name">{testCase.name}</span>
          <span className="muted mono">{testCase.durationS !== undefined ? `${testCase.durationS.toFixed(1)}s` : ""}</span>
        </div>
      )) : <p className="muted">The runner printed totals only.</p>}
    </div>
  );
}

export function TestResultsCard({ tests }: { tests: TestReportView | null }) {
  const ok = tests && tests.failed === 0;
  return (
    <section className="panel card-panel" aria-label="Test results">
      <div className="panel-bar"><span className="panel-title">Test Results</span></div>
      <div className="panel-body scroll">
        {!tests ? <Empty icon="beaker">No test run yet.</Empty> : (
          <>
            <div className={`test-summary ${ok ? "ok" : "bad"}`}>
              <Icon name={ok ? "check" : "error"} size={20} />
              <strong>{ok ? `${tests.passed} tests passed` : `${tests.failed} failed · ${tests.passed} passed`}</strong>
              <span className="spacer" />
              {tests.durationS !== undefined && <span className="muted mono">{tests.durationS.toFixed(1)}s</span>}
            </div>
            {tests.cases.slice(0, 6).map((testCase, index) => (
              <div key={`${testCase.name}-${index}`} className="test-case compact">
                <Icon name={testCase.status === "passed" ? "check" : "error"} size={14} className={testCase.status === "passed" ? "tone-text-success" : "tone-text-danger"} />
                <span className="test-name">{testCase.name}</span>
                <span className="muted mono">{testCase.durationS !== undefined ? `${testCase.durationS.toFixed(1)}s` : ""}</span>
              </div>
            ))}
            {tests.cases.length > 6 && <div className="muted small">… {tests.cases.length - 6} more</div>}
          </>
        )}
      </div>
    </section>
  );
}

export function ConversationCard({ messages }: { messages: ConversationMessage[] }) {
  return (
    <section className="panel card-panel" aria-label="Agent conversation">
      <div className="panel-bar"><span className="panel-title">Agent Conversation</span></div>
      <div className="panel-body scroll"><ConversationList messages={messages.slice(-12)} compact /></div>
    </section>
  );
}

export function ConversationList({ messages, compact }: { messages: ConversationMessage[]; compact?: boolean }) {
  if (!messages.length) return <Empty icon="chat">No conversation for this task.</Empty>;
  return (
    <div className={`conversation ${compact ? "compact" : ""}`}>
      {messages.map(message => (
        <div key={message.id} className={`message role-${message.role}`}>
          {message.agent ? <Avatar agent={message.agent} size={compact ? 24 : 28} /> : <PersonAvatar name={message.authorName} size={compact ? 24 : 28} />}
          <div className="message-body">
            <div className="message-meta"><strong>{message.authorName}</strong><span className="muted">{clock(message.at)}</span>{message.role === "result" && <span className="result-tag">result</span>}</div>
            <div className="bubble"><Markdown text={compact && message.content.length > 600 ? `${message.content.slice(0, 600)}…` : message.content} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}
