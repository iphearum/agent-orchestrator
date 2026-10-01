import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { FileChangeView, FlowNode, FlowView, MetricsView, TaskView, WorkEvent } from "@shared/protocol";
import { call } from "../bridge";
import { agentStyle } from "../agentColors";
import { AgentChip, Avatar, Empty, IconButton, StatusDot, Tabs } from "../components";
import { clock, duration } from "../format";
import { Icon } from "../icons";

export type FlowTab = "flow" | "plan" | "files" | "timeline" | "metrics";

export function FlowPanel({ tab, onTab, flow, task, files, events, metrics }: {
  tab: FlowTab; onTab: (tab: FlowTab) => void; flow: FlowView; task: TaskView; files: FileChangeView[]; events: WorkEvent[]; metrics: MetricsView;
}) {
  const [scale, setScale] = useState(1);
  const [fitRequest, setFitRequest] = useState(0);
  return (
    <section className="panel flow-panel" aria-label="Task views">
      <div className="panel-bar">
        <Tabs label="Task views" value={tab} onChange={onTab} tabs={[
          { id: "flow", label: "Agent Flow" }, { id: "plan", label: "Task Plan" }, { id: "files", label: "Files", count: files.length || undefined },
          { id: "timeline", label: "Timeline" }, { id: "metrics", label: "Metrics" }
        ]} />
        <span className="spacer" />
        <span className={`live-badge ${task.running ? "live" : ""}`}>{task.running ? "Live" : "Snapshot"}</span>
        {tab === "flow" && <>
          <IconButton icon="zoomOut" label="Zoom out" onClick={() => setScale(value => Math.max(.5, +(value - .1).toFixed(2)))} />
          <IconButton icon="zoomIn" label="Zoom in" onClick={() => setScale(value => Math.min(1.6, +(value + .1).toFixed(2)))} />
          <IconButton icon="fit" label="Fit to view" onClick={() => setFitRequest(value => value + 1)} />
        </>}
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "flow" && <AgentFlowGraph flow={flow} scale={scale} onScale={setScale} fitRequest={fitRequest} />}
        {tab === "plan" && <PlanView task={task} />}
        {tab === "files" && <FilesList files={files} />}
        {tab === "timeline" && <Timeline events={events} />}
        {tab === "metrics" && <Metrics metrics={metrics} task={task} />}
      </div>
    </section>
  );
}

const NODE_W = 164, NODE_H = 58, COL_GAP = 42, ROW_GAP = 12, PAD = 16;

export function AgentFlowGraph({ flow, scale, onScale, fitRequest }: { flow: FlowView; scale: number; onScale: (scale: number) => void; fitRequest: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => {
    const layers = new Map<number, FlowNode[]>();
    for (const node of flow.nodes) layers.set(node.layer, [...(layers.get(node.layer) ?? []), node]);
    const tallest = Math.max(1, ...[...layers.values()].map(nodes => nodes.length));
    // Reserve a lane under the nodes only when an edge has to skip a column and route below them.
    const layerOf = new Map(flow.nodes.map(node => [node.id, node.layer]));
    const underLane = flow.edges.some(edge => (layerOf.get(edge.to) ?? 0) - (layerOf.get(edge.from) ?? 0) > 1) ? 28 : 0;
    const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP + underLane;
    const maxLayer = Math.max(0, ...flow.nodes.map(node => node.layer));
    const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * COL_GAP;
    const positions = new Map<string, { x: number; y: number }>();
    for (const [layer, nodes] of layers) {
      const columnHeight = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
      const top = (height - underLane - columnHeight) / 2;
      nodes.forEach((node, index) => positions.set(node.id, { x: PAD + layer * (NODE_W + COL_GAP), y: top + index * (NODE_H + ROW_GAP) }));
    }
    return { width, height, positions };
  }, [flow]);

  // Fit on first render of a new graph and whenever the fit button is pressed.
  const nodeKey = flow.nodes.map(node => node.id).join("|");
  useEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const fit = Math.min(1, (box.clientWidth - 8) / layout.width, (box.clientHeight - 8) / layout.height);
    onScale(Math.max(.5, +fit.toFixed(2)));
  }, [nodeKey, fitRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  return (
    <div className="flow-viewport" ref={viewport}>
      <div className="flow-sizer" style={{ width: layout.width * scale, height: layout.height * scale }}>
        <div className="flow-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
          <svg className="flow-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {flow.edges.map(edge => {
              const from = layout.positions.get(edge.from), to = layout.positions.get(edge.to);
              const source = byId.get(edge.from), target = byId.get(edge.to);
              if (!from || !to || !source || !target) return null;
              const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x - 6, y2 = to.y + NODE_H / 2;
              // Edges that skip a column run under the graph so they don't cross the nodes in between.
              const skip = target.layer - source.layer > 1;
              const bottom = layout.height - 10;
              const d = skip
                ? `M${x1},${y1} C${x1 + 50},${bottom} ${x2 - 50},${bottom} ${x2},${y2}`
                : `M${x1},${y1} C${x1 + COL_GAP / 2},${y1} ${x2 - COL_GAP / 2},${y2} ${x2},${y2}`;
              const hue = source.agent ? agentStyle(source.agent.color) : undefined;
              const active = target.state === "active" || source.state === "active";
              return (
                <g key={`${edge.from}>${edge.to}`} style={hue} className={`flow-edge ${source.agent ? "" : "neutral"} ${active ? "active" : ""}`}>
                  <path d={d} />
                  <polygon points={`${x2},${y2 - 4} ${x2 + 6},${y2} ${x2},${y2 + 4}`} />
                  {active && <circle className="flow-particle" r="3">
                    <animateMotion path={d} dur="1.8s" repeatCount="indefinite" rotate="auto" />
                  </circle>}
                </g>
              );
            })}
          </svg>
          {flow.nodes.map(node => {
            const pos = layout.positions.get(node.id)!;
            return <FlowNodeCard key={node.id} node={node} style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H, animationDelay: `${Math.min(node.layer * 90, 450)}ms` }} />;
          })}
        </div>
      </div>
    </div>
  );
}

function FlowNodeCard({ node, style }: { node: FlowNode; style: CSSProperties }) {
  const hue = node.agent ? agentStyle(node.agent.color) : undefined;
  return (
    <div className={`flow-node kind-${node.kind} state-${node.state}`} style={{ ...style, ...hue }} title={`${node.title}: ${node.subtitle}`}>
      {node.kind === "agent" && node.agent ? <Avatar agent={node.agent} size={30} />
        : node.kind === "request" ? <span className="avatar person" style={{ width: 30, height: 30 }} aria-hidden="true"><Icon name="person" /></span>
          : <span className={`result-mark state-${node.state}`} aria-hidden="true"><Icon name={node.state === "failed" ? "close" : node.state === "done" ? "check" : "flag"} /></span>}
      <span className="flow-node-copy">
        <strong>{node.title}</strong>
        <small>{node.subtitle}</small>
      </span>
      {node.agent && (
        <span className="flow-node-dot">
          {node.agent.state === "idle" && node.state === "done" ? <Icon name="check" size={13} className="tone-text-success" title={`${node.agent.name}: done`} />
            : node.agent.state === "idle" && node.state === "failed" ? <Icon name="error" size={13} className="tone-text-danger" title={`${node.agent.name}: stopped`} />
              : <StatusDot state={node.agent.state} name={node.agent.name} />}
        </span>
      )}
    </div>
  );
}

function PlanView({ task }: { task: TaskView }) {
  if (!task.plan) return <Empty icon="plan">No plan yet. Agents create one with the <code>create_plan</code> tool.</Empty>;
  return (
    <div className="plan-view">
      {task.plan.objective && <p className="plan-objective">{task.plan.objective}</p>}
      <PlanChecklist steps={task.plan.steps} />
    </div>
  );
}

export function PlanChecklist({ steps }: { steps: NonNullable<TaskView["plan"]>["steps"] }) {
  if (!steps.length) return <Empty>The plan has no steps.</Empty>;
  return (
    <ol className="checklist">
      {steps.map(step => (
        <li key={step.id} className={`check-item step-${step.status}`}>
          <span className="check-mark" aria-hidden="true">{step.status === "completed" ? <Icon name="check" size={12} /> : step.status === "failed" ? <Icon name="close" size={12} /> : null}</span>
          <span>{step.description}</span>
          <span className="visually-hidden">({step.status})</span>
        </li>
      ))}
    </ol>
  );
}

export function FilesList({ files, onSelect }: { files: FileChangeView[]; onSelect?: (file: FileChangeView) => void }) {
  if (!files.length) return <Empty icon="file">No files changed by agents in this task.</Empty>;
  return (
    <ul className="file-list">
      {files.map(file => (
        <li key={file.id}>
          <button type="button" className="file-row" onClick={() => onSelect ? onSelect(file) : void call("ui.openFile", { path: file.path })} title={onSelect ? `Show ${file.path}` : `Open ${file.path}`}>
            <Icon name="file" />
            <span className="file-path">{file.path}</span>
            <span className="additions">+{file.additions}</span>
            {file.deletions !== undefined && <span className="deletions">-{file.deletions}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ events }: { events: WorkEvent[] }) {
  const dated = events.filter(event => event.agent && event.kind !== "live" && !Number.isNaN(Date.parse(event.at)));
  if (!dated.length) return <Empty>No activity yet.</Empty>;
  const start = Date.parse(dated[0].at), end = Math.max(start + 1000, Date.parse(dated[dated.length - 1].at));
  const lanes = new Map<string, WorkEvent[]>();
  for (const event of dated) lanes.set(event.agent!.id, [...(lanes.get(event.agent!.id) ?? []), event]);
  return (
    <div className="timeline">
      <div className="timeline-scale"><span>{clock(dated[0].at)}</span><span>{duration(end - start)}</span><span>{clock(dated[dated.length - 1].at)}</span></div>
      {[...lanes.values()].map(lane => (
        <div key={lane[0].agent!.id} className="timeline-lane" style={agentStyle(lane[0].agent!.color)}>
          <AgentChip agent={lane[0].agent} />
          <div className="timeline-track">
            {lane.map(event => (
              <span key={event.id} className={`timeline-dot status-${event.status}`} style={{ left: `${((Date.parse(event.at) - start) / (end - start)) * 100}%` }} title={`${clock(event.at)} · ${event.label}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Metrics({ metrics, task }: { metrics: MetricsView; task: TaskView }) {
  const tiles: Array<[string, string, string?]> = [
    ["Duration", task.running ? "running" : duration(metrics.durationMs)],
    ["Tool runs", String(metrics.toolRuns), metrics.toolFailures ? `${metrics.toolFailures} failed` : undefined],
    ["Tool time", duration(metrics.toolTimeMs)],
    ["Delegations", String(metrics.delegations)],
    ["Decisions", String(metrics.decisions), `${metrics.layaDecisions} Laya · ${metrics.fallbackDecisions} fallback`],
    ["Memories used", String(metrics.memoriesRetrieved)],
    ["Graph facts used", String(metrics.graphFacts)],
    ["Subtasks", String(task.counts.subtasks)]
  ];
  return (
    <div className="metrics-grid">
      {tiles.map(([label, value, note]) => (
        <div key={label} className="metric-tile"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong>{note && <small>{note}</small>}</div>
      ))}
    </div>
  );
}
