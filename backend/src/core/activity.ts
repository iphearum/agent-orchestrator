import type { RunEvent } from "./orchestrator";
import type { AgentRunState } from "../shared/protocol";

type Listener = (change: { rootTaskId?: string }) => void;

interface RootRun { openAgents: number; agents: Map<string, AgentRunState> }

/** Busiest state wins when one agent works in several runs at once. */
const STATE_RANK: Record<AgentRunState, number> = { waiting: 5, delegating: 4, running: 3, thinking: 2, failed: 1, idle: 0 };

/**
 * Live run state derived from orchestrator events. The database does not record
 * which agents are working right now, so the UI reads it from here.
 */
export class RuntimeActivity {
  private readonly roots = new Map<string, RootRun>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<Listener>();

  handle(event: RunEvent) {
    const rootTaskId = event.rootTaskId;
    if (!rootTaskId) return;
    let run = this.roots.get(rootTaskId);
    if (!run) {
      run = { openAgents: 0, agents: new Map() };
      this.roots.set(rootTaskId, run);
    }
    switch (event.type) {
      case "start":
        run.openAgents++;
        this.failed.delete(event.agentId);
        run.agents.set(event.agentId, "thinking");
        break;
      case "delegate":
        run.agents.set(event.agentId, "delegating");
        break;
      case "tool":
        if (event.phase === "start") run.agents.set(event.agentId, event.text.startsWith("Waiting for approval") ? "waiting" : "running");
        else run.agents.set(event.agentId, "thinking");
        break;
      case "message":
      case "chunk":
      case "thinking_chunk":
      case "thinking_message":
      case "stream_reset":
        if (run.agents.get(event.agentId) !== "delegating") run.agents.set(event.agentId, "thinking");
        break;
      case "result":
      case "error":
        run.openAgents = Math.max(0, run.openAgents - 1);
        run.agents.delete(event.agentId);
        if (event.type === "error") this.failed.add(event.agentId);
        if (run.openAgents === 0) this.roots.delete(rootTaskId);
        break;
    }
    // Streaming chunks arrive many times per second and do not change what the UI shows.
    if (event.type !== "chunk" && event.type !== "thinking_chunk" && event.type !== "thinking_message") this.fire({ rootTaskId });
  }

  /** Called when a run's promise settles, so a missed result/error event cannot leave it "running" forever. */
  finishRoot(rootTaskId: string) {
    if (this.roots.delete(rootTaskId)) this.fire({ rootTaskId });
  }

  agentState(agentId: string): AgentRunState {
    let best: AgentRunState = this.failed.has(agentId) ? "failed" : "idle";
    for (const run of this.roots.values()) {
      const state = run.agents.get(agentId);
      if (state && STATE_RANK[state] > STATE_RANK[best]) best = state;
    }
    return best;
  }

  agentStateInRoot(rootTaskId: string, agentId: string): AgentRunState | undefined {
    return this.roots.get(rootTaskId)?.agents.get(agentId);
  }

  isRootRunning(rootTaskId: string) { return this.roots.has(rootTaskId); }

  runningRootIds() { return [...this.roots.keys()]; }

  agentsRunning() {
    const busy = new Set<string>();
    for (const run of this.roots.values()) for (const agentId of run.agents.keys()) busy.add(agentId);
    return busy.size;
  }

  onDidChange(listener: Listener) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private fire(change: { rootTaskId?: string }) {
    for (const listener of this.listeners) listener(change);
  }
}
