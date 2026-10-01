import { AgentState } from "../core/types";
import type { DecisionPolicy } from "../core/decision";

export type LayaToolCategory = "none" | "workspace_read" | "workspace_write" | "memory" | "knowledge_graph" | "planning" | "agent_communication" | "shell";

/**
 * Only the answers the runtime acts on. Every question costs Laya a full pass over the state (seconds on a CPU),
 * so routing asks just `agent`, and agents ask `needs_memory`, `needs_graph` and `tool`.
 */
export interface LayaDecisionResult {
  agent?: { value: string; confidence: number };
  needsMemory?: { value: boolean; confidence: number };
  needsGraph?: { value: boolean; confidence: number };
  tool?: { value: LayaToolCategory; confidence: number };
  routing?: unknown;
  teamPlan?: LayaTeamPlan;
}

export interface LayaTeamPlanTask { id: string; agent_id: string; instruction: string; depends_on: string[]; }
export interface LayaTeamPlan { objective: string; tasks: LayaTeamPlanTask[]; }

/** Laya's question primitives: `noul` is a yes/no probability, `choice` picks one criteria key. */
type Question = { type: "noul"; instructions: string } | { type: "choice"; instructions: string; criteria: Record<string, string> };
/**
 * Typed answers, e.g. from laya-multilingual:
 *   noul   {"type":"noul","noul":0.97}                                 → probability of "yes"
 *   choice {"type":"choice","choice":"billing","confidence":1.0,"probabilities":{…}}
 *   score  {"type":"score","score":1.9,"confidence":0.7,"legend":{…},"probabilities":{…}}
 * Older Jev-compatible services answer yes/no questions as a choice of "yes"/"no" with a probability.
 */
type Answer = { type?: unknown; choice?: unknown; noul?: unknown; score?: unknown; confidence?: unknown; probability?: unknown; probabilities?: unknown };
export interface LayaClientConfig {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  /** Sent as "model" when set, e.g. "laya-multilingual". */
  model?: string;
  /** Sent as "keep_alive" when set, e.g. "30m": how long Ollama-style servers keep the model loaded after a request. */
  keepAlive?: string;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Ollama unloads an idle model after 5 minutes unless the request says otherwise. */
const DEFAULT_KEEP_ALIVE_MS = 5 * 60_000;

/** Parse a keep_alive value ("30m", "1h", "300s", "90", "-1") into milliseconds; negative means "forever". */
export function keepAliveMs(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_KEEP_ALIVE_MS;
  const match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text);
  if (!match) return DEFAULT_KEEP_ALIVE_MS;
  const amount = Number(match[1]);
  if (amount < 0) return Number.POSITIVE_INFINITY;
  const unit = (match[2] ?? "s").toLowerCase();
  return amount * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

/** Timeouts, dropped connections, overload (429) and server errors can pass; a bad key, URL or payload will not. */
function isTransient(error: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  const status = error instanceof LayaHttpError ? error.status : undefined;
  if (status === undefined) return error instanceof TypeError; // fetch reports network failures as TypeError
  return status === 429 || status >= 500;
}

class LayaHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Transient failures in a row before Laya is paused; one slow answer should not cost the whole session. */
const PAUSE_AFTER_FAILURES = 3;

/** Recent conversation sent with a decision. Laya re-reads the state per question, so it stays short. */
const RECENT_CONTEXT_CHARS = 1200;

function rankedTeamWorkers(state: AgentState, request: NonNullable<AgentState["teamPlanRequest"]>) {
  const words = `${request.objective} ${state.message}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2);
  return request.agents.map((agent, index) => ({ agent, index, score: words.reduce((score, word) => score + ([agent.id, agent.name, agent.description, ...agent.skills].join(" ").toLowerCase().includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name) || a.agent.id.localeCompare(b.agent.id))
    .slice(0, Math.min(12, 20, request.maxTasks));
}

/** Read a yes/no answer: native `noul` probability, or a legacy "yes"/"no" choice. */
export function readYesNo(answer: Answer | undefined): { value: boolean; confidence: number } | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
    const yes = clamp01(answer.noul);
    // Confidence is the probability of the answer we act on, so 0.02 means a confident "no".
    return { value: yes >= .5, confidence: Math.max(yes, 1 - yes) };
  }
  const choice = readChoice(answer);
  if (!choice || !["yes", "no"].includes(choice.value.toLowerCase())) return undefined;
  return { value: choice.value.toLowerCase() === "yes", confidence: choice.confidence };
}

/**
 * Read a choice answer. Its confidence is the chosen option's probability: Unsloth's Laya docs say to
 * act on `probabilities`, because its `confidence` measures how spread out the options are, not how
 * likely the choice is. Jev-style services without probabilities fall back to probability/confidence.
 */
export function readChoice(answer: Answer | undefined): { value: string; confidence: number } | undefined {
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string") return undefined;
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities as Record<string, unknown> : {};
  const fromProbabilities = probabilities[answer.choice];
  const confidence = typeof fromProbabilities === "number" ? fromProbabilities
    : typeof answer.probability === "number" ? answer.probability
      : typeof answer.confidence === "number" ? answer.confidence : .5;
  return { value: answer.choice, confidence: clamp01(Number.isFinite(confidence) ? confidence : .5) };
}

/**
 * Whether a paused client is due a background check: retries are on, and the pause (or the last check) is at least
 * `retryMinutes` old. Checks never run while a chat waits; they only decide when the next small warm-up request goes out.
 */
export function shouldRetryLaya(status: { paused?: boolean; pausedAt?: string }, lastCheckAt: number, retryMinutes: number, now = Date.now()): boolean {
  if (!status.paused || !(retryMinutes > 0)) return false;
  const since = Math.max(Date.parse(status.pausedAt ?? "") || now, lastCheckAt);
  return now - since >= retryMinutes * 60_000;
}

/** Time allowed for a cold start (model load), used by warm-up and connection tests only. */
const COLD_START_TIMEOUT_MS = 30_000;

/** Thin client for Laya's Jev-compatible POST /v1/systemone endpoint. */
export class LayaHttpClient {
  private lastError?: string;
  private lastSuccessAt?: string;
  /**
   * Set after a permanent failure (bad key, URL, payload) or PAUSE_AFTER_FAILURES transient ones in a row: Laya is
   * then skipped (fallback decisions) until resume(), a successful test, or new settings.
   */
  private pausedAt?: string;
  private consecutiveFailures = 0;
  /** After a transient failure the model may still be loading, so the next request gets the cold-start timeout. */
  private mayBeCold = false;
  private configuredTarget?: string;
  private keepAliveUnsupported = false;
  /** How long the last answered request took, so a timeout can say how far off the limit is. */
  private lastLatencyMs?: number;

  constructor(private readonly config: () => LayaClientConfig | Promise<LayaClientConfig>) {}

  get status() { return { connected: !this.lastError && Boolean(this.lastSuccessAt), paused: Boolean(this.pausedAt), pausedAt: this.pausedAt, lastError: this.lastError, lastSuccessAt: this.lastSuccessAt, lastLatencyMs: this.lastLatencyMs, consecutiveFailures: this.consecutiveFailures }; }

  /** Manual reset: the next decision calls Laya again. */
  resume() { this.pausedAt = undefined; this.lastError = undefined; this.consecutiveFailures = 0; }

  /**
   * Whether the model has probably been unloaded: never answered, a request just failed, or it has been idle longer
   * than the server keeps it loaded. Loading takes 10-30 s on a CPU, far above a warm answer's timeout.
   */
  private isCold(keepAlive: string | undefined, now = Date.now()): boolean {
    if (!this.lastSuccessAt || this.mayBeCold) return true;
    // Unload happens keep_alive after the last request; leave a margin for clock and queueing slack.
    return now - Date.parse(this.lastSuccessAt) > keepAliveMs(keepAlive) - 15_000;
  }

  /** `force` bypasses the back-off; `minTimeoutMs` lets explicit checks wait out Laya's cold start. */
  async decide(state: AgentState, policy: DecisionPolicy, agents: Array<{ id: string; name: string; description: string; skills: string[] }>, force = false, minTimeoutMs = 0): Promise<LayaDecisionResult> {
    const loaded = await this.config();
    const cfg = { ...loaded, endpoint: loaded.endpoint.trim() };
    // New endpoint, model or key: whatever failed before may work now, so resume.
    const target = `${cfg.endpoint}\n${cfg.model ?? ""}\n${cfg.apiKey ?? ""}\n${cfg.keepAlive ?? ""}`;
    if (this.configuredTarget !== target) { this.configuredTarget = target; this.keepAliveUnsupported = false; this.resume(); }
    if (!force && this.pausedAt) {
      // Paused for the session: skip Laya without waiting on it, and say so in the trace.
      throw new Error(`Laya is paused since ${new Date(this.pausedAt).toLocaleTimeString()} after: ${this.lastError || "an earlier failure"} Using the fallback until Laya is resumed.`);
    }
    if (!cfg.endpoint.trim()) { this.lastError = "Laya endpoint is not configured."; throw new Error(this.lastError); }
    let endpoint: URL;
    try { endpoint = new URL(cfg.endpoint); }
    catch { this.lastError = "Laya endpoint URL is invalid."; throw new Error(this.lastError); }
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))) {
      this.lastError = "Laya endpoints must use HTTPS (HTTP is allowed for localhost).";
      throw new Error(this.lastError);
    }
    const questions = this.questions(state, policy, agents);
    const model = cfg.model?.trim();
    const keepAlive = cfg.keepAlive?.trim();
    const requestState = model && /(?:^|\/)laya(?:[-/]|$)/i.test(model)
      ? this.stateText(state, policy)
      : this.compactState(state);
    const controller = new AbortController();
    const cold = this.isCold(this.keepAliveUnsupported ? undefined : keepAlive);
    const timeoutMs = Math.max(100, Math.min(60_000, Math.max(cfg.timeoutMs, minTimeoutMs, cold ? COLD_START_TIMEOUT_MS : 0)));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const send = (includeKeepAlive: boolean) => fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ ...(model ? { model } : {}), ...(includeKeepAlive ? { keep_alive: keepAlive } : {}), state: requestState, questions }),
        signal: controller.signal
      });
      const requestedKeepAlive = Boolean(keepAlive) && !this.keepAliveUnsupported;
      let response = await send(requestedKeepAlive);
      if (requestedKeepAlive && response.status === 400) {
        const detail = await response.text();
        if (/Unsupported field\(s\):\s*keep_alive/i.test(detail)) {
          // Unsloth's Decision API rejects this Ollama-only extension; retry within the same timeout.
          this.keepAliveUnsupported = true;
          response = await send(false);
        } else {
          throw new LayaHttpError(response.status, `Laya returned HTTP ${response.status}: ${detail.slice(0, 400)}`);
        }
      }
      if (!response.ok) throw new LayaHttpError(response.status, `Laya returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
      const data = await response.json() as { answers?: Record<string, Answer>; routing?: unknown };
      if (!data.answers || typeof data.answers !== "object") throw new Error("Laya returned a response without typed answers.");
      this.lastError = undefined;
      this.pausedAt = undefined;
      this.consecutiveFailures = 0;
      this.mayBeCold = false;
      this.lastSuccessAt = new Date().toISOString();
      this.lastLatencyMs = Date.now() - startedAt;
      return this.mapAnswers(data.answers, data.routing, state, policy);
    } catch (error) {
      const aborted = controller.signal.aborted;
      this.lastError = aborted
        ? `Laya request timed out after ${timeoutMs}ms${this.lastLatencyMs !== undefined ? ` (the last answer took ${this.lastLatencyMs}ms)` : ""}. Raise the Laya timeout if the service is slow.`
        : error instanceof Error ? error.message : String(error);
      this.consecutiveFailures++;
      this.mayBeCold = true;
      // A slow or briefly unreachable Laya falls back for this decision only; pause when it keeps failing or can't work.
      if (!isTransient(error, aborted) || this.consecutiveFailures >= PAUSE_AFTER_FAILURES) this.pausedAt = new Date().toISOString();
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Connection check. With agents it sends the same routing request a chat starts with, so
   * the test sees the real payload and latency instead of passing on a much smaller request.
   */
  async ping(agents: Array<{ id: string; name: string; description: string; skills: string[] }> = []) {
    const message = "Connection check: which agent should review this repository's recent changes?";
    // Mirrors Orchestrator.runRoot's usual first routing call (agent choice; team questions only come with team-sized requests).
    const state: AgentState = agents.length
      ? { agentId: agents[0].id, agentName: "global", message, availableTools: [] }
      : { agentId: "system", agentName: "System", message, availableTools: [] };
    const policy = agents.length ? "global" : "general";
    const cfg = await this.config();
    let startedAt = Date.now();
    let result = await this.decide(state, policy, agents, true, COLD_START_TIMEOUT_MS);
    let latencyMs = Date.now() - startedAt;
    // A slow first answer may be the model loading; time a second request to see what chats will get.
    let coldStartMs: number | undefined;
    if (latencyMs > cfg.timeoutMs * .7) {
      coldStartMs = latencyMs;
      startedAt = Date.now();
      result = await this.decide(state, policy, agents, true, COLD_START_TIMEOUT_MS);
      latencyMs = Date.now() - startedAt;
    }
    return { ...result, latencyMs, coldStartMs };
  }

  /**
   * Laya loads its model on the first request, which takes 10-20 s; later requests are fast. Send a
   * small request with a long timeout so the first chat doesn't time out and trip the back-off.
   */
  async warmUp() {
    const cfg = await this.config();
    if (!cfg.endpoint.trim()) return;
    const state: AgentState = { agentId: "system", agentName: "System", message: "Warm-up", availableTools: [] };
    try { await this.decide(state, "general", [], true, COLD_START_TIMEOUT_MS); } catch { /* status already records the error */ }
  }

  private questions(state: AgentState, policy: DecisionPolicy, agents: Array<{ id: string; name: string; description: string; skills: string[] }>): Record<string, Question> {
    const yesNo = (instructions: string): Question => ({ type: "noul", instructions });
    const questions: Record<string, Question> = {};
    if (policy === "global") return this.routingQuestions(state, agents, yesNo);
    // Vector retrieval, "needs the LLM" and delegation are not asked: the runtime has no vector store, always runs the
    // model, and lets the agent's model delegate through its tools. Each unused question cost a full pass over the state.
    questions.needs_memory = yesNo("Would the current agent benefit from retrieving its relevant stored memories for this request?");
    questions.needs_graph = yesNo("Would relevant entities and their relationships materially help answer this request?");
    const toolCriteria: Record<LayaToolCategory, string> = {
      none: "No external tool or retrieval category is needed right now.",
      workspace_read: "Read or search project files and repository state.",
      workspace_write: "Create or modify workspace files.",
      memory: "Retrieve or save agent memory.",
      knowledge_graph: "Retrieve or update entities and relationships.",
      planning: "Create or update a structured task plan.",
      agent_communication: "Ask or delegate work to another agent.",
      shell: "Run a shell command; this always remains subject to explicit authorization."
    };
    const profileTools: LayaToolCategory[] = policy === "coder"
      ? ["none", "workspace_read", "workspace_write", "memory", "knowledge_graph", "planning", "agent_communication"]
      : policy === "researcher"
        ? ["none", "workspace_read", "memory", "knowledge_graph", "agent_communication"]
        : policy === "planner"
          ? ["none", "memory", "knowledge_graph", "planning", "agent_communication"]
          : ["none", "workspace_read", "memory", "knowledge_graph", "planning", "agent_communication"];
    if (state.availableTools.includes("run_command")) profileTools.push("shell");
    questions.tool = { type: "choice", instructions: `Which single capability category should be considered first for ${state.agentName}? Choose none when no tool is needed.`, criteria: Object.fromEntries(profileTools.map(name => [name, toolCriteria[name]])) };
    return questions;
  }

  /** The supervisor's routing call: which agent owns the request (plus team questions for team-sized requests). */
  private routingQuestions(state: AgentState, agents: Array<{ id: string; name: string; description: string; skills: string[] }>, yesNo: (instructions: string) => Question): Record<string, Question> {
    const questions: Record<string, Question> = {};
    if (state.teamPlanRequest) {
      questions.team = {
        type: "choice",
        instructions: "Decide whether this request needs multiple worker agents. If it does, select the relevant workers using the team_worker questions. Use single when one agent can complete the request. These answers assign work only; they never grant tools or permissions.",
        criteria: {
          team: "Two or more available specialists should each complete a distinct part of this request.",
          single: "One worker can complete this request without a team plan."
        }
      };
      const workers = rankedTeamWorkers(state, state.teamPlanRequest);
      workers.forEach(({ agent, index }) => {
        questions[`team_worker_${index}`] = yesNo(`Should ${agent.name} be assigned a separate work item for this request? ${agent.description} Skills: ${agent.skills.join(", ")}.`);
      });
    }
    const words = state.message.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2);
    const routeCandidates = agents.map(agent => ({ agent, score: words.reduce((score, word) => score + ([agent.id, agent.name, agent.description, ...agent.skills].join(" ").toLowerCase().includes(word) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name)).slice(0, 20).map(item => item.agent);
    questions.agent = {
      type: "choice",
      instructions: "Choose the one available agent best suited to own the user's request.",
      criteria: Object.fromEntries(routeCandidates.map(agent => [agent.id, `${agent.name}: ${agent.description}; skills: ${agent.skills.join(", ")}`]))
    };
    return questions;
  }

  private compactState(state: AgentState) {
    return {
      agent_id: state.agentId,
      agent_name: state.agentName,
      message: state.message.slice(0, 6000),
      task: state.currentTask && state.currentTask.instruction !== state.message ? state.currentTask : undefined,
      plan: state.activePlan,
      available_tools: state.availableTools.slice(0, 20),
      recent_context: state.recentContextSummary?.slice(-RECENT_CONTEXT_CHARS),
      relevant_entities: state.relevantEntities?.slice(0, 20),
      // No separate roster: routing lists every agent in the `agent` criteria, and other policies don't choose agents.
      team_plan_request: state.teamPlanRequest ? { objective: state.teamPlanRequest.objective.slice(0, 6000), max_tasks: state.teamPlanRequest.maxTasks, available_agents: state.teamPlanRequest.agents.slice(0, 20) } : undefined
    };
  }

  /**
   * laya-multilingual's public SystemOne API takes state text, and reads all of it again for every question, so it
   * carries only what the questions need. The roster goes in only for team requests: routing lists every agent in
   * the `agent` criteria already, and other policies don't choose between agents.
   */
  private stateText(state: AgentState, policy: DecisionPolicy): string {
    const workerRoster = policy === "global" && state.teamPlanRequest ? state.teamPlanRequest.agents : [];
    const sections = [
      `User request:\n${state.message.slice(0, 6000)}`,
      state.teamPlanRequest ? `Team objective:\n${state.teamPlanRequest.objective.slice(0, 6000)}` : undefined,
      workerRoster.length ? `Available agents:\n${workerRoster.slice(0, 20).map(agent => `- ${agent.id}: ${agent.name} — ${agent.description.slice(0, 180)}${agent.skills.length ? ` (skills: ${agent.skills.slice(0, 12).join(", ")})` : ""}`).join("\n")}` : undefined,
      state.currentTask && state.currentTask.instruction !== state.message ? `Current task:\n${state.currentTask.instruction.slice(0, 2000)}` : undefined,
      state.activePlan ? `Active plan:\n${state.activePlan.objective.slice(0, 1000)}` : undefined,
      state.recentContextSummary ? `Recent context:\n${state.recentContextSummary.slice(-RECENT_CONTEXT_CHARS)}` : undefined,
      state.relevantEntities?.length ? `Relevant entities:\n${state.relevantEntities.slice(0, 20).join(", ")}` : undefined
    ].filter((section): section is string => Boolean(section));
    return sections.join("\n\n").slice(0, 14_000);
  }

  private mapAnswers(answers: Record<string, Answer>, routing: unknown, state: AgentState, policy: DecisionPolicy): LayaDecisionResult {
    // A missing or malformed answer counts as an unsure "no" / the fallback option.
    const choice = (key: string, fallback: string) => readChoice(answers[key]) ?? { value: fallback, confidence: .5 };
    const yesNo = (key: string) => readYesNo(answers[key]) ?? { value: false, confidence: .5 };
    const tools: LayaToolCategory[] = ["none", "workspace_read", "workspace_write", "memory", "knowledge_graph", "planning", "agent_communication", "shell"];
    const tool = choice("tool", "none");
    const teamChoice = [readChoice(answers.team), readChoice(answers.team_plan)]
      .find(answer => answer && ["team", "single"].includes(answer.value.toLowerCase()));
    const teamPlan = policy === "global" && state.teamPlanRequest
      ? this.teamPlanFromAnswers(answers, routing, state, state.teamPlanRequest, teamChoice)
      : undefined;
    if (policy === "global") return { agent: choice("agent", state.agentId), routing, ...(teamPlan ? { teamPlan } : {}) };
    return {
      needsMemory: yesNo("needs_memory"),
      needsGraph: yesNo("needs_graph"),
      tool: { value: tools.includes(tool.value as LayaToolCategory) ? tool.value as LayaToolCategory : "none", confidence: tool.confidence },
      routing
    };
  }

  /** Prefer Laya's explicit graph; otherwise turn its per-worker answers into a bounded flat team plan. */
  private teamPlanFromAnswers(
    answers: Record<string, Answer>,
    routing: unknown,
    state: AgentState,
    request: NonNullable<AgentState["teamPlanRequest"]>,
    teamChoice?: { value: string; confidence: number }
  ): LayaTeamPlan | undefined {
    const explicit = validateLayaTeamPlan(routing, request.agents);
    if (explicit && (!teamChoice || teamChoice.value.toLowerCase() === "team")) return explicit;
    if (teamChoice?.value.toLowerCase() === "single") return undefined;

    const workers = rankedTeamWorkers(state, request);
    const selected = workers.filter(({ index }) => readYesNo(answers[`team_worker_${index}`])?.value === true).map(({ agent }) => agent);
    // A team must contain at least two distinct workers. The scheduler enforces the concurrency cap.
    if (selected.length < 2 || (teamChoice && teamChoice.value.toLowerCase() !== "team")) return undefined;

    const tasks = selected.map((agent, index) => ({
      id: `worker-${index + 1}`,
      agent_id: agent.id,
      instruction: `Complete the user's request as the ${agent.name} specialist. Focus on ${agent.description}${agent.skills.length ? ` Skills: ${agent.skills.join(", ")}.` : ""} Produce a concrete, self-contained result for the coordinator to combine. User request: ${request.objective.slice(0, 5000)}`,
      depends_on: [] as string[]
    }));
    return { objective: request.objective.trim().slice(0, 6000), tasks };
  }
}

/** Accept only the explicit Laya routing.team_plan contract; reject unsafe or ambiguous graphs. */
export function validateLayaTeamPlan(routing: unknown, agents: Array<{ id: string }>): LayaTeamPlan | undefined {
  if (!routing || typeof routing !== "object") return undefined;
  const raw = (routing as { team_plan?: unknown }).team_plan;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as { objective?: unknown; tasks?: unknown };
  if (typeof candidate.objective !== "string" || !candidate.objective.trim() || !Array.isArray(candidate.tasks) || candidate.tasks.length < 1 || candidate.tasks.length > 12) return undefined;
  const available = new Set(agents.map(agent => agent.id));
  const ids = new Set<string>();
  const tasks: LayaTeamPlanTask[] = [];
  for (const item of candidate.tasks) {
    if (!item || typeof item !== "object") return undefined;
    const task = item as { id?: unknown; agent_id?: unknown; instruction?: unknown; depends_on?: unknown };
    if (typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(task.id) || ids.has(task.id)) return undefined;
    if (typeof task.agent_id !== "string" || !available.has(task.agent_id)) return undefined;
    if (typeof task.instruction !== "string" || !task.instruction.trim() || task.instruction.length > 6000) return undefined;
    if (!Array.isArray(task.depends_on) || task.depends_on.some(dep => typeof dep !== "string")) return undefined;
    ids.add(task.id);
    tasks.push({ id: task.id, agent_id: task.agent_id, instruction: task.instruction.trim(), depends_on: task.depends_on as string[] });
  }
  if (tasks.some(task => task.depends_on.some(dep => !ids.has(dep) || dep === task.id))) return undefined;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) if (!visit(dep)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (tasks.some(task => !visit(task.id))) return undefined;
  return { objective: candidate.objective.trim().slice(0, 6000), tasks };
}
