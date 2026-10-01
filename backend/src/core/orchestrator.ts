import { randomUUID } from "crypto";
import { AgentDatabase } from "../persistence/database";
import { OpenAICompatibleModel } from "./model";
import { AGENT_TOOLS, FULL_ACCESS_TOOLS } from "./tools";
import { AgentDecision, AgentDefinition, AgentMessage, ChatImageAttachment, RunContext, ToolCall } from "./types";
import { AgentDecisionEngine, decisionMode } from "./decision";
import { AgentMessageBus } from "./agentMessageBus";
import { describeFound, FIND_TOOLS_SCHEMA, rankTools, toFunctionName, toFunctionSchema, type ExternalTool, type ExternalToolHost } from "./externalTools";
import { fallbackTeamPlan, mayNeedTeam, type TeamPlan, type TeamPlanTask } from "./teamIntent";
import { JevService } from "../jev/service";
import { normalizeWorkspaceArgs } from "../tools/fileView";

export interface RunEvent {
  type: "start" | "message" | "chunk" | "thinking_chunk" | "thinking_message" | "stream_reset" | "delegate" | "tool" | "result" | "error";
  agentId: string;
  text: string;
  phase?: "start" | "complete" | "error";
  toolCallId?: string;
  toolName?: string;
  path?: string;
  /** For "delegate" events: which agent the work went to, and whether it is a question ("ask") or a whole task. */
  targetAgentId?: string;
  delegateMode?: "ask" | "delegate";
  /** Root task of the run that produced this event. */
  rootTaskId?: string;
}

export interface OrchestratorConfig {
  layaEnabled: boolean;
  maxDelegationDepth: number;
  maxDelegationsPerTask: number;
  contextRecentMessages: number;
  contextMaxTokens?: number;
  automaticExecutionConfidence?: number;
  contextEnrichmentConfidence?: number;
  /** Agents started by hand-offs and teams in one request, across every level; keeps fan-out bounded. */
  maxAgentRunsPerRequest?: number;
}

export interface ChatRunOptions {
  conversationId?: string;
  images?: ChatImageAttachment[];
  attachedImageNames?: string[];
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  planMode?: boolean;
  title?: string;
  displayPrompt?: string;
  approvalMode?: "ask" | "approve" | "full";
  providerId?: string;
  model?: string;
}

export interface RemoteAgentContext {
  taskId: string; rootTaskId: string; conversationId?: string; depth: number;
  /** The user's approval mode, for runners that map it onto their own permission settings. */
  approvalMode?: "ask" | "approve" | "full";
  /** Live progress from runners that stream it (tool use, messages). */
  onProgress?: (update: { kind: "tool-start" | "tool-end" | "message"; id?: string; toolName?: string; path?: string; text?: string; failed?: boolean }) => void;
}
export interface RemoteAgentRunner {
  run(agent: AgentDefinition, instruction: string, context: RemoteAgentContext): Promise<string>;
}
export interface SocketAgentRunner extends RemoteAgentRunner {}

export interface ToolApprovalRequest { agentId: string; agentName: string; toolName: string; argumentsJson: string; /** Explains what approving does; shown in the approval dialog. */ detail?: string; }
export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;
export interface WorkspaceToolHandler { execute(name: string, arguments_: Record<string, unknown>): Promise<string>; }

/** Workspace reads whose results are already bounded by the tool itself. */
const SELF_LIMITED_READS = new Set(["read_file", "file_outline", "search_workspace"]);
/** Tools that start another agent; they share the reachable-agent list, guards and run budget. */
const HANDOFF_TOOLS = ["ask_agent", "delegate_task", "delegate_team"];

/** Short social/meta turns should be answered by one agent, even if routing returns a team graph. */
function isSingleAgentConversationTurn(message: string): boolean {
  const text = message.toLowerCase().trim().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
  return /^(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|nice|who are you|what are you|what is your name|are you human|tell me about yourself|what can you do|who made you)$/.test(text);
}

export class Orchestrator {
  /** Each Orchestrator instance serves one runRoot call, so this identifies its events. */
  private rootTaskId?: string;
  /** Agents started by hand-offs and teams in this request (each Orchestrator serves one runRoot). */
  private agentRuns = 0;
  private jevService?: JevService;
  /** The JEV knowledge graph, over the same database connection. */
  private get jev() { return this.jevService ??= new JevService(this.db.connection); }

  constructor(
    private db: AgentDatabase,
    private model: OpenAICompatibleModel,
    private onEvent?: (e: RunEvent) => void,
    private decisions = new AgentDecisionEngine(),
    private runtimeConfig: OrchestratorConfig = { layaEnabled: true, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 },
    private requestToolApproval?: ToolApprovalHandler,
    private runFullAccessCommand?: (command: string) => Promise<string>,
    private remoteAgentRunner?: RemoteAgentRunner,
    private messageBus?: AgentMessageBus,
    private socketAgentRunner?: SocketAgentRunner,
    private workspaceTools?: WorkspaceToolHandler,
    /** MCP / VS Code extension tools; only a few relevant ones are offered per turn. */
    private externalTools?: ExternalToolHost,
    /** Coding-agent CLIs (Claude Code, Codex, …) that run a whole task themselves. */
    private cliAgentRunner?: RemoteAgentRunner
  ) {}

  async runRoot(instruction: string, rootAgentId = "lead", autoRoute = true, options: ChatRunOptions = {}): Promise<string> {
    const rootTaskId = randomUUID();
    this.rootTaskId = rootTaskId;
    const conversationId = options.conversationId || randomUUID();
    if (!this.db.hasConversation(conversationId)) this.db.createConversation(conversationId, options.title || instruction);
    const previousRequests = this.db.hasConversation(conversationId)
      ? this.db.recentMessages(conversationId, 8).filter(message => message.startsWith("user: ")).map(message => message.slice(6)).slice(-2)
      : [];
    const newImageNames = options.attachedImageNames || [];
    const imageNote = newImageNames.length ? `\n[${newImageNames.length} image${newImageNames.length === 1 ? "" : "s"} attached: ${newImageNames.join(", ")}]` : "";
    this.db.addConversationMessage(randomUUID(), conversationId, null, "user", (options.displayPrompt || instruction) + imageNote);
    const available = this.db.listAgents();
    const shortFollowUp = instruction.trim().split(/\s+/).length <= 6;
    const routeMessage = shortFollowUp && previousRequests.length
      ? `Earlier request: ${previousRequests.at(-1)}\nFollow-up: ${instruction}`
      : instruction;
    // Team questions make the routing request several times larger; ask them only when the request looks like team work.
    const askForTeam = mayNeedTeam(instruction) && !isSingleAgentConversationTurn(instruction);
    const route = autoRoute && this.runtimeConfig.layaEnabled
      ? await this.decisions.route({ agentId: rootAgentId, agentName: "global", message: routeMessage, availableTools: [], ...(askForTeam ? { teamPlanRequest: {
        objective: instruction, maxTasks: 12, agents: available.filter(agent => agent.id !== rootAgentId).map(({ id, name, description, skills }) => ({ id, name, description, skills }))
      } } : {}) }, available)
      : { agent: { value: rootAgentId, confidence: 1 }, source: "none" } as AgentDecision;
    const routeConfidence = route.agent?.confidence ?? 0;
    const routeThreshold = this.runtimeConfig.automaticExecutionConfidence ?? .9;
    const minimumRouteConfidence = route.source === "rules" ? (this.runtimeConfig.contextEnrichmentConfidence ?? .65) : routeThreshold;
    const routedAgent = ["laya", "rules"].includes(route.source || "") && routeConfidence >= minimumRouteConfidence && typeof route.agent?.value === "string" ? route.agent.value : rootAgentId;
    const selected = this.db.getAgent(routedAgent) ? routedAgent : rootAgentId;
    const teamPlan = (route as AgentDecision & { teamPlan?: TeamPlan }).teamPlan;
    const eligibleTeamPlan = !isSingleAgentConversationTurn(instruction) ? teamPlan : undefined;
    this.db.trace(conversationId, rootTaskId, eligibleTeamPlan?.tasks.length ? "lead" : selected, "routing", {
      ...route,
      routeContextUsed: routeMessage !== instruction,
      teamPlanRequested: askForTeam,
      ...(teamPlan && !eligibleTeamPlan ? { teamPlan: undefined, teamPlanSkipped: "single_agent_conversation_turn" } : {})
    });
    // Laya may hand back a team plan. Without one, the agent decides who to involve: it can ask, delegate to, or
    // run a team of any other agents (delegate_team), and those agents can do the same.
    if (autoRoute && eligibleTeamPlan?.tasks.length) return this.runTeamPlan(instruction, eligibleTeamPlan, rootTaskId, conversationId, options);

    return this.runAgent(selected, instruction, {
      rootTaskId,
      taskId: rootTaskId,
      depth: 0,
      delegationCount: 0,
      ancestorAgents: [],
      conversationId,
      images: options.images,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
      planMode: options.planMode,
      approvalMode: options.approvalMode,
      providerId: options.providerId,
      model: options.model
    });
  }

  /** Laya's team plan: the lead runs it as a team, then integrates the results into the reply. */
  private async runTeamPlan(request: string, plan: TeamPlan, rootTaskId: string, conversationId: string, options: ChatRunOptions): Promise<string> {
    const coordinator = this.db.getAgent("lead")!;
    this.db.createTask({ id: rootTaskId, rootId: rootTaskId, ownerAgentId: coordinator.id, instruction: request, depth: 0 });
    const ctx: RunContext = {
      rootTaskId, taskId: rootTaskId, depth: 0, delegationCount: 0, ancestorAgents: [], conversationId,
      images: options.images, thinking: options.thinking, reasoningEffort: options.reasoningEffort,
      approvalMode: options.approvalMode, providerId: options.providerId, model: options.model, existingTask: true
    };
    this.db.trace(conversationId, rootTaskId, coordinator.id, "decision", { kind: "team_plan", source: "laya", objective: plan.objective, tasks: plan.tasks });
    const team = await this.runTeam(coordinator, plan, ctx, request);
    if (!team.some(part => part.status === "completed")) {
      const message = `Every team task failed: ${team.map(part => `${part.name}: ${part.result}`).join(" ")}`;
      this.db.failTask(rootTaskId, message);
      throw new Error(message);
    }
    const results = team.map(part => `### ${part.name}: ${part.instruction}\n${part.status === "completed" ? part.result : `Not finished. ${part.result}`}`).join("\n\n");
    // The lead is still an orchestrator here: it may call more agents before it answers.
    return this.runAgent(coordinator.id, `Integrate the completed team work into one clear reply to the user. Preserve important caveats and report incomplete work accurately.\n\nOriginal request:\n${request}\n\nTeam results:\n${results}`, ctx);
  }

  /**
   * Run several agents as a team for `caller`: parts without dependencies run in parallel (three at a time), a part
   * with `depends_on` starts once those finish and gets their results. A failed part doesn't stop the others;
   * dependents run on whatever finished. Every member is a full agent and may call other agents itself, within the
   * depth, cycle and per-request run limits. Returns each part's outcome for the caller to use.
   */
  private async runTeam(caller: AgentDefinition, plan: TeamPlan, ctx: RunContext, request?: string): Promise<Array<{ id: string; agentId: string; name: string; instruction: string; status: "completed" | "failed" | "skipped"; result: string }>> {
    const nameOf = (agentId: string) => this.db.getAgent(agentId)?.name ?? agentId;
    const planId = this.db.activePlan(ctx.taskId)?.id ?? (() => { const id = randomUUID(); this.db.createPlan(id, ctx.taskId, plan.objective); return id; })();
    const firstPosition = (this.db.connection.prepare("SELECT COUNT(*) AS n FROM plan_steps WHERE plan_id=?").get(planId) as { n: number }).n;
    const taskIds = new Map<string, string>();
    const stepIds = new Map<string, string>();
    const completed = new Map<string, string>();
    // Failed or skipped parts, with why.
    const unfinished = new Map<string, { status: "failed" | "skipped"; why: string }>();
    const refuse = (id: string, why: string) => {
      unfinished.set(id, { status: "failed", why });
      this.db.failTask(taskIds.get(id)!, why);
      this.db.updatePlanStep(stepIds.get(id)!, "failed", why);
    };

    plan.tasks.forEach((item, index) => {
      const taskId = randomUUID();
      taskIds.set(item.id, taskId);
      this.db.createTask({ id: taskId, parentId: ctx.taskId, rootId: ctx.rootTaskId, ownerAgentId: item.agent_id, instruction: item.instruction, depth: ctx.depth + 1, status: "pending" });
      const stepId = randomUUID();
      stepIds.set(item.id, stepId);
      this.db.addPlanStep(stepId, planId, firstPosition + index, `[${nameOf(item.agent_id)}] ${item.instruction}`);
      // The caller hands out independent parts; a dependent part is handed on by the parts it waits for.
      if (!item.depends_on.length) this.db.addMessage(ctx.taskId, caller.id, item.agent_id, "delegate", item.instruction);
      for (const depId of item.depends_on) this.db.addMessage(ctx.taskId, plan.tasks.find(dep => dep.id === depId)!.agent_id, item.agent_id, "delegate", item.instruction);
    });
    const settled = (id: string) => completed.has(id) || unfinished.has(id);
    const remaining = new Set(plan.tasks.map(item => item.id));
    while (remaining.size) {
      const ready = plan.tasks.filter(item => remaining.has(item.id) && item.depends_on.every(settled));
      if (!ready.length) {
        for (const id of remaining) refuse(id, "Not started: its dependencies form a cycle.");
        break;
      }
      ready.forEach(item => remaining.delete(item.id));
      const runnable: TeamPlanTask[] = [];
      for (const item of ready) {
        const blocked = this.handoffBlocked(caller, item.agent_id, ctx);
        if (item.depends_on.length && !item.depends_on.some(id => completed.has(id))) {
          const why = `Skipped: nothing it depends on finished (${item.depends_on.map(id => nameOf(plan.tasks.find(dep => dep.id === id)!.agent_id)).join(", ")}).`;
          unfinished.set(item.id, { status: "skipped", why });
          this.db.failTask(taskIds.get(item.id)!, why);
          this.db.updatePlanStep(stepIds.get(item.id)!, "skipped", why);
        } else if (blocked) refuse(item.id, blocked);
        else { this.agentRuns++; runnable.push(item); }
      }
      for (let offset = 0; offset < runnable.length; offset += 3) {
        const batch = runnable.slice(offset, offset + 3);
        batch.forEach(item => {
          this.db.setTaskStatus(taskIds.get(item.id)!, "active");
          this.db.updatePlanStep(stepIds.get(item.id)!, "active");
          // Each member shows as its own hand-off in the chat, opened here and closed by the matching tool event below.
          this.emit("delegate", caller.id, `delegate -> ${nameOf(item.agent_id)}: ${item.instruction}`, { targetAgentId: item.agent_id, delegateMode: "delegate", toolCallId: `team:${taskIds.get(item.id)}` });
        });
        const outcomes = await Promise.allSettled(batch.map(item => {
          const dependencies = item.depends_on.map(id => {
            const dep = nameOf(plan.tasks.find(task => task.id === id)!.agent_id);
            return completed.has(id) ? `\n\nResult from ${dep}:\n${completed.get(id)!.slice(0, 4000)}` : `\n\n${dep} did not finish: ${unfinished.get(id)?.why}`;
          }).join("");
          const instruction = `${request ? `User request: ${request}\n\n` : ""}Your part of a team task from ${caller.name}: ${item.instruction}${dependencies}`;
          return this.runAgent(item.agent_id, instruction, {
            rootTaskId: ctx.rootTaskId, taskId: taskIds.get(item.id)!, depth: ctx.depth + 1, delegationCount: ctx.delegationCount + 1,
            ancestorAgents: [...ctx.ancestorAgents, caller.id], conversationId: ctx.conversationId,
            images: ctx.images, thinking: ctx.thinking, reasoningEffort: ctx.reasoningEffort, planMode: ctx.planMode,
            approvalMode: ctx.approvalMode, providerId: ctx.providerId, model: ctx.model, existingTask: true
          }, ctx.taskId);
        }));
        outcomes.forEach((outcome, index) => {
          const item = batch[index];
          const answer = outcome.status === "fulfilled" ? { result: outcome.value } : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
          this.emit("tool", caller.id, JSON.stringify(answer), { phase: outcome.status === "fulfilled" ? "complete" : "error", toolCallId: `team:${taskIds.get(item.id)}`, toolName: "delegate_task" });
          if (outcome.status === "fulfilled") {
            completed.set(item.id, outcome.value);
            this.db.updatePlanStep(stepIds.get(item.id)!, "completed", outcome.value.slice(0, 4000));
            // Parts at the end of the team report back to the caller; the others' results went to their dependents.
            if (!plan.tasks.some(other => other.depends_on.includes(item.id))) this.db.addMessage(taskIds.get(item.id)!, item.agent_id, caller.id, "response", outcome.value);
          } else {
            const why = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            unfinished.set(item.id, { status: "failed", why });
            this.db.updatePlanStep(stepIds.get(item.id)!, "failed", why);
          }
        });
      }
    }
    return plan.tasks.map(item => ({
      id: item.id, agentId: item.agent_id, name: nameOf(item.agent_id), instruction: item.instruction,
      status: completed.has(item.id) ? "completed" as const : unfinished.get(item.id)!.status,
      result: completed.get(item.id) ?? unfinished.get(item.id)!.why
    }));
  }

  /** Why `caller` may not start `targetId` now, or undefined when it may: the guards every hand-off shares. */
  private handoffBlocked(caller: AgentDefinition, targetId: string, ctx: RunContext): string | undefined {
    if (!this.db.getAgent(targetId)) return `Agent '${targetId}' does not exist.`;
    if (targetId === caller.id) return "An agent cannot hand work to itself.";
    if (ctx.ancestorAgents.includes(targetId)) return `${targetId} is already waiting on this request (${[...ctx.ancestorAgents, caller.id].join(" -> ")}).`;
    if (ctx.depth + 1 > this.runtimeConfig.maxDelegationDepth) return `Delegation depth limit (${this.runtimeConfig.maxDelegationDepth}) reached.`;
    const budget = this.runtimeConfig.maxAgentRunsPerRequest ?? 12;
    if (this.agentRuns >= budget) return `This request already started ${budget} agent runs, the limit. Finish with what the team has.`;
    return undefined;
  }

  private async runAgent(
    agentId: string,
    instruction: string,
    ctx: RunContext,
    parentTaskId?: string
  ): Promise<string> {
    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    this.guard(agent, ctx);

    if (ctx.existingTask) {
      // The scheduler persists the complete graph before workers start.
    } else if (ctx.depth === 0) {
      this.db.createTask({
        id: ctx.taskId,
        rootId: ctx.rootTaskId,
        ownerAgentId: agentId,
        instruction,
        depth: ctx.depth
      });
    } else {
      this.db.createTask({
        id: ctx.taskId,
        parentId: parentTaskId,
        rootId: ctx.rootTaskId,
        ownerAgentId: agentId,
        instruction,
        depth: ctx.depth
      });
    }

    this.emit("start", agentId, instruction);

    if (agent.n8nLinkId) {
      if (!this.remoteAgentRunner) throw new Error(`Agent '${agent.name}' is linked to n8n, but no n8n transport is configured.`);
      try {
        const result = await this.remoteAgentRunner.run(agent, instruction, { taskId: ctx.taskId, rootTaskId: ctx.rootTaskId, conversationId: ctx.conversationId, depth: ctx.depth });
        this.db.completeTask(ctx.taskId, result);
        this.db.addMessage(ctx.taskId, agentId, null, "assistant", result);
        if (ctx.conversationId) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, ctx.depth === 0 ? "result" : "assistant", result);
        this.emit("result", agentId, result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.failTask(ctx.taskId, message);
        this.emit("error", agentId, message);
        throw error;
      }
    }

    if (agent.cliLinkId) {
      if (!this.cliAgentRunner) throw new Error(`Agent '${agent.name}' runs through a CLI, but no CLI runner is configured.`);
      const openTools = new Set<string>();
      try {
        const result = await this.cliAgentRunner.run(agent, instruction, {
          taskId: ctx.taskId, rootTaskId: ctx.rootTaskId, conversationId: ctx.conversationId, depth: ctx.depth, approvalMode: ctx.approvalMode,
          onProgress: update => {
            if (update.kind === "tool-start" && update.id) {
              openTools.add(update.id);
              this.emit("tool", agentId, `Using ${update.toolName ?? "tool"}`, { phase: "start", toolCallId: update.id, toolName: update.toolName, path: update.path });
            } else if (update.kind === "tool-end" && update.id && openTools.delete(update.id)) {
              this.emit("tool", agentId, update.text ?? "", { phase: update.failed ? "error" : "complete", toolCallId: update.id, toolName: update.toolName, path: update.path });
              this.db.recordToolRun(ctx.conversationId, ctx.taskId, agentId, `${agent.cliLinkId}:${update.toolName ?? "tool"}`, { path: update.path }, (update.text ?? "").slice(0, 4000), update.failed ? "failed" : "completed");
            } else if (update.kind === "message" && update.text) {
              this.db.addMessage(ctx.taskId, agentId, null, "assistant", update.text);
            }
          }
        });
        this.db.completeTask(ctx.taskId, result);
        if (ctx.conversationId) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, ctx.depth === 0 ? "result" : "assistant", result);
        this.emit("result", agentId, result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.failTask(ctx.taskId, message);
        this.emit("error", agentId, message);
        throw error;
      }
    }

    if (agent.socketLinkId) {
      if (!this.socketAgentRunner) throw new Error(`Agent '${agent.name}' is linked to a socket, but no socket transport is configured.`);
      try {
        const result = await this.socketAgentRunner.run(agent, instruction, { taskId: ctx.taskId, rootTaskId: ctx.rootTaskId, conversationId: ctx.conversationId, depth: ctx.depth });
        this.db.completeTask(ctx.taskId, result);
        this.db.addMessage(ctx.taskId, agentId, null, "assistant", result);
        if (ctx.conversationId) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, ctx.depth === 0 ? "result" : "assistant", result);
        this.emit("result", agentId, result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.failTask(ctx.taskId, message);
        this.emit("error", agentId, message);
        throw error;
      }
    }

    let decisionTools = this.toolsAllowedFor(agent, ctx);
    const expandedPages = new Set<string>();
    // expand_tool_result is offered only once a result was shortened; before that, small models invent tool_run_ids.
    let shortenedResults = 0;
    // Identical reads within one agent run return a reminder instead of the same content again.
    const earlierReads = new Map<string, string>();
    // A call that failed fails again with the same arguments; small models otherwise retry it until the turn limit.
    const failedCalls = new Map<string, string>();
    const failedToolCounts = new Map<string, number>();
    const disabledTools = new Set<string>();
    let failedDelegations = 0;
    let askedForAnswer = false;
    // External tools: the agent always gets find_tools, plus the few tools most relevant to the task (spec: 1–3 schemas, not all).
    const externalForAgent: ExternalTool[] = ctx.planMode ? [] : this.externalTools?.forAgent(agentId) ?? [];
    const activeExternal = new Map<string, ExternalTool>();
    const activate = (tools: ExternalTool[]) => {
      for (const tool of tools) {
        const name = toFunctionName(tool.name);
        if (disabledTools.has(name)) continue;
        activeExternal.delete(name);
        activeExternal.set(name, tool);
      }
      while (activeExternal.size > 6) activeExternal.delete(activeExternal.keys().next().value!);
    };
    activate(rankTools(externalForAgent, instruction, 2));
    let lastToolName = "";
    // JEV: entities the request names plus what earlier turns of this chat touched, and the facts one hop around them.
    const knowledge = this.jev.retrieve({ query: instruction, conversationId: ctx.conversationId, taskIds: [ctx.rootTaskId], limit: 12 });
    const localDecision = await this.decisions.decide(agent, {
      agentId,
      agentName: agent.name,
      message: instruction,
      currentTask: { id: ctx.taskId, instruction, status: "active" },
      activePlan: this.db.activePlan(ctx.taskId),
      availableTools: decisionTools.map(tool => tool.function.name),
      recentContextSummary: ctx.conversationId ? this.db.recentMessages(ctx.conversationId, this.contextRecentMessages()).join("\n") : undefined,
      relevantEntities: knowledge.entities.map(entity => entity.name).slice(0, 8)
    }, this.db.listAgents());
    const enrichmentThreshold = this.runtimeConfig.contextEnrichmentConfidence ?? .65;
    const memoryMode = decisionMode(localDecision.needsMemory.confidence, this.runtimeConfig.automaticExecutionConfidence ?? .9, enrichmentThreshold);
    const graphMode = decisionMode(localDecision.needsGraph.confidence, this.runtimeConfig.automaticExecutionConfidence ?? .9, enrichmentThreshold);
    const explicitContextLookup = /\b(?:related|history|histories|historical|previous|prior|earlier|similar|remember|memory|memories|last time|before)\b/i.test(instruction);
    const retrieveMemory = explicitContextLookup || (localDecision.source !== "none" && (localDecision.needsMemory.value === true || memoryMode === "reason"));
    const retrieveGraph = explicitContextLookup || (localDecision.source !== "none" && (localDecision.needsGraph.value === true || graphMode === "reason"));
    const entitySeeds = retrieveGraph ? knowledge.entities.map(entity => entity.name) : [];
    const graphFacts = retrieveGraph ? knowledge.facts.map(fact => fact.text) : [];
    if (retrieveGraph) this.db.trace(ctx.conversationId, ctx.taskId, agentId, "jev", { event: "retrieved", entities: knowledge.entities.length, facts: knowledge.facts.length, refs: knowledge.entities.map(entity => entity.ref).slice(0, 12) });
    const relatedHistory = retrieveGraph || retrieveMemory
      ? this.db.relatedConversationHistory(agentId, ctx.conversationId, instruction, [...entitySeeds, ...graphFacts], 4)
      : [];
    const memoryQuery = [instruction, ...entitySeeds, ...graphFacts].join(" ");
    const memories = retrieveMemory
      ? [...new Set([
          ...this.db.recentMemories(agentId, 8, memoryQuery),
          ...this.db.memoriesFromConversations(agentId, relatedHistory.map(item => item.conversationId), 6)
        ])].slice(0, 12)
      : [];
    const entities = retrieveGraph ? [...new Set([...entitySeeds, ...graphFacts])] : [];
    const recentContext = ctx.conversationId ? this.db.recentMessages(ctx.conversationId, this.contextRecentMessages()) : [];
    const relatedContext = relatedHistory.map(item => item.context);
    const context = this.fitContext([...relatedContext, ...recentContext], memories, entities);
    this.db.trace(ctx.conversationId, ctx.taskId, agentId, "decision", { ...localDecision, gates: { memoryMode, graphMode, enrichmentThreshold } });
    this.db.trace(ctx.conversationId, ctx.taskId, agentId, "retrieval", { memoryCount: context.memories.length, graphFactCount: context.entities.length, recentContextItems: recentContext.length, relatedConversationCount: relatedHistory.length, vectorEnabled: false, explicitContextLookup });
    const userContent: AgentMessage["content"] = ctx.images?.length
      ? [
          { type: "text", text: instruction },
          ...ctx.images.map(image => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))
        ]
      : instruction;
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: this.buildSystemPrompt(agent, context.memories, context.entities, context.messages, ctx, instruction)
      },
      { role: "user", content: userContent }
    ];

    try {
      for (let turn = 0; turn < 20; turn++) {
        const automaticThreshold = localDecision.source === "rules" ? (this.runtimeConfig.contextEnrichmentConfidence ?? .65) : (this.runtimeConfig.automaticExecutionConfidence ?? .9);
        const modeTools = (["laya", "rules"].includes(localDecision.source || "") && localDecision.tool.confidence >= automaticThreshold
          ? this.filterByCategory(decisionTools, String(localDecision.tool.value))
          : decisionTools).filter(tool => tool.function.name !== "expand_tool_result" || shortenedResults > 0);
        const availableTools = ctx.planMode
          ? modeTools.filter(tool => tool.function.name === "create_plan")
          : [...modeTools, ...(externalForAgent.length ? [...(disabledTools.has("find_tools") ? [] : [FIND_TOOLS_SCHEMA]), ...[...activeExternal.values()].map(toFunctionSchema)] : [])];
        const recoveryAttempt = askedForAnswer;
        const offeredTools = recoveryAttempt ? [] : availableTools;
        // Laya narrows the schemas per turn, so keep the prompt in sync with the tools
        // actually sent to the model. This prevents advice to search/delegate when the
        // corresponding tool was filtered out for this decision.
        const offeredNames = offeredTools.map(tool => tool.function.name);
        const prompt = String(messages[0]?.content ?? "");
        const toolAvailability = `\n\nTools available this turn: ${offeredNames.length ? offeredNames.join(", ") : "none"}. Call only a listed tool. For workspace searches, provide a non-empty query from the request or project context. For expand_tool_result, copy a tool_run_id exactly from an earlier tool result; if no ID is visible, continue without expanding.`;
        messages[0] = { ...messages[0], content: `${prompt.replace(/\n\nTools available this turn:[\s\S]*$/, "")}${toolAvailability}` };
        // After an empty streamed turn, recover with a plain JSON chat completion and no tools.
        // This avoids repeating the same empty/tool loop and lets the model return a direct answer.
        const streamAnswer = ctx.depth === 0 && !recoveryAttempt;
        const response = await this.model.chat(
          messages,
          offeredTools,
          { providerId: ctx.providerId || agent.providerId, model: ctx.model || agent.model, reasoningEffort: ctx.reasoningEffort },
          streamAnswer ? text => this.emit("chunk", agentId, text) : undefined,
          !recoveryAttempt ? text => this.emit("thinking_chunk", agentId, text) : undefined
        );
        if (recoveryAttempt && response.toolCalls.length) {
          throw new Error("The model returned a tool call during the non-streaming recovery attempt.");
        }

        if (ctx.depth === 0 && response.toolCalls.length) this.emit("stream_reset", agentId, "");

        if (response.content) {
          messages.push({ role: "assistant", content: response.content ?? "" });
          this.db.addMessage(ctx.taskId, agentId, null, "assistant", response.content);
          this.emit("message", agentId, response.content);
        }

        if (!response.toolCalls.length && !response.content?.trim()) {
          // Small or reasoning models sometimes end with neither text nor a tool call (all output went to reasoning, or the
          // prompt overflowed the model's context). Ask once more; if it is still empty, fail visibly instead of "(no result)".
          if (!askedForAnswer) {
            askedForAnswer = true;
            messages.push({ role: "user", content: "Your last reply was empty. Answer using the existing conversation and tool results; no tools are available for this retry. Use this concise format: Answer: the direct answer first. Evidence: the files or results that support it. Confidence: high, medium, or low. Missing context: include only what you could not verify. Do not expose private reasoning, ask broad questions, or return an empty answer." });
            continue;
          }
          const modelName = ctx.model || agent.model;
          throw new Error(`The model${modelName ? ` (${modelName})` : ""} returned an empty answer${response.thinkingText ? " after reasoning" : ""}. Try a larger model, a lower reasoning effort, or a new chat with less history.`);
        }

        if (!response.toolCalls.length) {
          const finalResult = response.content ?? "(no result)";
          this.db.completeTask(ctx.taskId, finalResult);
          if (!ctx.planMode) this.db.remember(agentId, "private", `Completed task: ${instruction}\nResult: ${finalResult.slice(0, 1800)}`, "episodic", ctx.conversationId);
          // Conversation history stores the final result once; intermediate assistant content stays in task messages.
          if (ctx.conversationId && ctx.depth === 0) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, "result", finalResult);
          if (ctx.conversationId && ctx.depth === 0) this.db.compressConversation(ctx.conversationId, Math.max(8, this.contextRecentMessages() * 2));
          this.db.trace(ctx.conversationId, ctx.taskId, agentId, "memory", { stored: true, resultLength: finalResult.length });
          this.emit("result", agentId, finalResult);
          return finalResult;
        }

        // Preserve the assistant's tool-call turn in OpenAI-compatible format.
        (messages as any).push({
          role: "assistant",
          content: response.content,
          tool_calls: response.toolCalls
        });

        for (const call of response.toolCalls) {
          const toolStartedAt = Date.now();
          lastToolName = call.function.name;
          let toolArgs: Record<string, unknown> = {};
          try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch { /* tool validation reports malformed arguments */ }
          let repeatedToolResultPage = false;
          if (call.function.name === "expand_tool_result") {
            const pageKey = `${String(toolArgs.tool_run_id || "")}:${Math.max(0, Math.floor(Number(toolArgs.offset) || 0))}`;
            repeatedToolResultPage = expandedPages.has(pageKey);
            if (!repeatedToolResultPage) expandedPages.add(pageKey);
          }
          const external = activeExternal.get(call.function.name);
          // External tools can do anything (risk 2): they need approval unless the user chose full access or auto-approved them.
          const approvalRequired = external
            ? ctx.approvalMode !== "full" && !this.externalTools?.autoApproved(external.name)
            : ctx.approvalMode === "ask" && ["write_file", "remember", "remember_entity", "remember_relation"].includes(call.function.name);
          const runCall = async (): Promise<string> => {
            if (call.function.name === "find_tools") {
              const found = rankTools(externalForAgent, String(toolArgs.query ?? ""), 3);
              activate(found);
              return describeFound(found, String(toolArgs.query ?? ""));
            }
            if (external) {
              try { return await this.externalTools!.invoke(external.name, toolArgs); }
              catch (error) { return JSON.stringify({ error: `${external.name} failed: ${error instanceof Error ? error.message : String(error)}` }); }
            }
            // A tool that throws must not end the agent's run: the error goes back to the model like any failed result.
            try { return await this.executeTool(agent, call, ctx); }
            catch (error) { return JSON.stringify({ error: `${call.function.name} failed: ${error instanceof Error ? error.message : String(error)}` }); }
          };
          const workspaceArgs = normalizeWorkspaceArgs(call.function.name, toolArgs);
          const toolPath = typeof workspaceArgs.path === "string" && workspaceArgs.path ? workspaceArgs.path : undefined;
          const readKey = SELF_LIMITED_READS.has(call.function.name) ? `${call.function.name}:${JSON.stringify(toolArgs)}` : "";
          const earlierRead = readKey ? earlierReads.get(readKey) : undefined;
          const callKey = `${call.function.name}:${call.function.arguments || ""}`;
          const earlierFailure = failedCalls.get(callKey);
          const wasOffered = availableTools.some(tool => tool.function.name === call.function.name);
          let result: string;
          if (!wasOffered) {
            this.emit("tool", agentId, `Rejected unavailable ${call.function.name}`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            result = JSON.stringify({ error: `${call.function.name} was not offered for this turn or has been disabled after repeated failures. Do not call it again; continue with the available tools or answer with what you have.` });
          } else if (repeatedToolResultPage) {
            this.emit("tool", agentId, `Skipped repeated ${call.function.name} page`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            result = JSON.stringify({ error: "This exact tool result page was already requested. Use a different offset or continue using the result already returned; do not repeat this page." });
          } else if (earlierFailure) {
            this.emit("tool", agentId, `Skipped repeated ${call.function.name}`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            result = JSON.stringify({ error: `This exact ${call.function.name} call already failed: ${earlierFailure} Do not repeat it. Change the arguments, or answer with what you have.` });
          } else if (earlierRead) {
            this.emit("tool", agentId, `Skipped repeated ${call.function.name}`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            result = JSON.stringify({ note: `You already ran this exact ${call.function.name} in this task (tool_run_id ${earlierRead}); its result is earlier in the conversation. Use it, read a different range with start_line/end_line, or answer now.` });
          } else if (approvalRequired) {
            this.emit("tool", agentId, `Waiting for approval: ${call.function.name}`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            const approved = await this.requestToolApproval?.({
              agentId, agentName: agent.name, toolName: external?.name ?? call.function.name, argumentsJson: call.function.arguments,
              detail: external ? `Runs the external tool "${external.name}" (from an MCP server or VS Code extension) with:\n${call.function.arguments.slice(0, 600)}` : undefined
            }) ?? false;
            result = approved ? await runCall() : JSON.stringify({ error: "The user declined this action. Continue without it." });
          } else {
            this.emit("tool", agentId, `Using ${call.function.name}`, { phase: "start", toolCallId: call.id, toolName: call.function.name, path: toolPath });
            result = await runCall();
          }
          const toolError = (() => { try { const error = JSON.parse(result)?.error; return error ? String(error) : ""; } catch { return ""; } })();
          const toolFailed = Boolean(toolError);
          if (toolFailed) {
            if (!earlierFailure) failedCalls.set(callKey, toolError);
            const failures = (failedToolCounts.get(call.function.name) ?? 0) + 1;
            failedToolCounts.set(call.function.name, failures);
            if (failures >= 2) {
              disabledTools.add(call.function.name);
              decisionTools = decisionTools.filter(tool => tool.function.name !== call.function.name);
              activeExternal.delete(call.function.name);
              result = JSON.stringify({ error: `${toolError} This tool has failed twice and is now disabled for this task. Continue with other available tools or provide the best answer from what you have.` });
            }
          }
          // Files the agents read or edited become file entities linked to the task (the task's Related Knowledge).
          const listedDirectory = toolPath && result.startsWith(`${toolPath.replace(/\/$/, "")}/ · directory`);
          if (!toolFailed && !listedDirectory && toolPath && ["read_file", "file_outline", "write_file"].includes(call.function.name)) {
            try { this.jev.linkFile(ctx.rootTaskId, toolPath, call.function.name === "write_file" ? "edited" : "read"); } catch { /* knowledge links are best-effort */ }
          }
          if (toolFailed && HANDOFF_TOOLS.includes(call.function.name) && ++failedDelegations >= 2 && decisionTools.some(tool => HANDOFF_TOOLS.includes(tool.function.name))) {
            // Two failed hand-offs: stop offering them so the agent answers instead of looping.
            decisionTools = decisionTools.filter(tool => !HANDOFF_TOOLS.includes(tool.function.name));
            result = JSON.stringify({ error: `${toolError} Delegation is now turned off for you on this task: answer with what you have.` });
          }
          this.emit("tool", agentId, result, { phase: toolFailed ? "error" : "complete", toolCallId: call.id, toolName: call.function.name, path: toolPath });
          const toolRunId = this.db.recordToolRun(ctx.conversationId, ctx.taskId, agentId, external?.name ?? call.function.name, toolArgs, result, toolFailed ? "failed" : "completed");
          if (readKey && !earlierRead && !toolFailed) earlierReads.set(readKey, toolRunId);
          this.db.trace(ctx.conversationId, ctx.taskId, agentId, "tool", { name: call.function.name, toolRunId, durationMs: Date.now() - toolStartedAt, resultChars: result.length, resultPreview: result.slice(0, 500) });

          // Reads that size themselves (about 8 KB at most) reach the model whole; cutting them made agents re-read in loops.
          const selfLimited = SELF_LIMITED_READS.has(call.function.name) && result.length <= 9000;
          const shortened = result.length > 3000 && call.function.name !== "expand_tool_result" && !selfLimited;
          if (shortened) shortenedResults++;
          const toolMessage = shortened
            ? `${result.slice(0, 2200)}\n\n[Tool result shortened to 2,200 of ${result.length} characters. Retrieve the next part with expand_tool_result using tool_run_id \"${toolRunId}\", offset 2200, and limit 6000.]`
            : result;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: toolMessage
          });
        }
      }

      throw new Error(`Agent reached 20 reasoning/tool turns${lastToolName ? ` (last tool: ${lastToolName})` : ""}. The task was stopped to prevent a tool loop.`);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.db.failTask(ctx.taskId, text);
      this.emit("error", agentId, text);
      throw err;
    }
  }

  private async executeTool(
    caller: AgentDefinition,
    call: ToolCall,
    ctx: RunContext
  ): Promise<string> {
    if (ctx.planMode && call.function.name !== "create_plan") {
      return JSON.stringify({ error: "Plan mode only allows saving a plan. Do not perform other actions." });
    }
    let args: any = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return JSON.stringify({ error: "Invalid JSON tool arguments." });
    }

    switch (call.function.name) {
      case "run_command":
        if (ctx.approvalMode !== "full") return JSON.stringify({ error: "Shell commands require Full access mode." });
        if (!this.runFullAccessCommand) return JSON.stringify({ error: "Shell command execution is unavailable." });
        return this.runFullAccessCommand(String(args.command ?? ""));

      case "search_workspace":
      case "read_file":
      case "file_outline":
      case "write_file":
        if (!this.workspaceTools) return JSON.stringify({ error: "Workspace file tools are unavailable." });
        return this.workspaceTools.execute(call.function.name, args);

      case "list_agents":
        return JSON.stringify(
          this.db.listAgents().map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            skills: a.skills,
            canDelegate: a.canDelegate
          }))
        );

      case "find_agent":
        return JSON.stringify(
          this.db.findAgents(String(args.capability ?? "")).map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            skills: a.skills
          }))
        );

      case "remember":
        this.db.remember(
          args.scope === "project" ? null : caller.id,
          args.scope === "project" ? "project" : "private",
          String(args.content),
          "semantic",
          ctx.conversationId
        );
        return JSON.stringify({ ok: true });

      case "create_plan": {
        const planId = randomUUID();
        this.db.createPlan(planId, ctx.taskId, String(args.objective));
        const steps = Array.isArray(args.steps) ? args.steps : [];
        steps.forEach((step: unknown, index: number) => this.db.addPlanStep(randomUUID(), planId, index, String(step)));
        return JSON.stringify({ ok: true, plan_id: planId, step_count: steps.length });
      }

      case "remember_entity": {
        try {
          const entityId = this.jev.upsertEntity(args.type, String(args.name ?? ""), args.data ?? {});
          this.jev.linkToTask(ctx.rootTaskId, entityId);
          return JSON.stringify({ ok: true, entity_id: entityId });
        } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
      }

      case "remember_relation": {
        try {
          const sourceMessageId = ctx.conversationId ? this.db.latestConversationMessageId(ctx.conversationId) : undefined;
          const fact = this.jev.recordFact({
            sourceName: String(args.source_name ?? ""), sourceType: args.source_type, predicate: String(args.predicate ?? ""),
            targetName: String(args.target_name ?? ""), targetType: args.target_type, confidence: Number(args.confidence), sourceMessageId
          });
          this.jev.linkToTask(ctx.rootTaskId, fact.sourceId);
          this.jev.linkToTask(ctx.rootTaskId, fact.targetId);
          if (fact.outcome === "replaced") this.db.trace(ctx.conversationId, ctx.taskId, caller.id, "jev", { event: "conflict_resolved", predicate: fact.predicate, relationId: fact.relationId, replaced: fact.replaced });
          return JSON.stringify({ ok: true, relation_id: fact.relationId, outcome: fact.outcome, ...(fact.replaced.length ? { replaced_old_values: fact.replaced.length } : {}) });
        } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
      }

      case "expand_tool_result": {
        const full = this.db.toolRunResult(String(args.tool_run_id || ""));
        if (full === undefined) {
          const refs = this.db.recentToolRunRefs(ctx.conversationId);
          const hint = refs.length ? ` Recent valid tool_run_id values in this conversation: ${refs.map(ref => `${ref.id} (${ref.tool_name})`).join(", ")}.` : " No earlier tool results are available in this conversation.";
          return JSON.stringify({ error: `Tool result was not found. Copy a tool_run_id exactly from an earlier tool result.${hint}` });
        }
        const offset = Math.max(0, Math.min(full.length, Math.floor(Number(args.offset) || 0)));
        const limit = Math.max(500, Math.min(6000, Math.floor(Number(args.limit) || 6000)));
        const end = Math.min(full.length, offset + limit);
        return `[Tool result characters ${offset}-${end} of ${full.length}]\n${full.slice(offset, end)}${end < full.length ? `\n\n[More remains. The next offset is ${end}.]` : ""}`;
      }

      case "ask_agent": {
        const handoff = this.handoffArguments(caller, args, ctx, "ask_agent", "question");
        if ("error" in handoff) return JSON.stringify({ error: handoff.error });
        return this.delegate(caller, handoff.targetId, `Consultation request from ${caller.name}:\n${handoff.text}`, ctx, "ask");
      }

      case "delegate_task": {
        const handoff = this.handoffArguments(caller, args, ctx, "delegate_task", "instruction");
        if ("error" in handoff) return JSON.stringify({ error: handoff.error });
        return this.delegate(caller, handoff.targetId, handoff.text, ctx, "delegate");
      }

      case "delegate_team": {
        if (!caller.canDelegate) return JSON.stringify({ error: `${caller.id} cannot delegate work; use ask_agent to consult another agent.` });
        const team = this.teamArguments(caller, args, ctx);
        if ("error" in team) return JSON.stringify({ error: team.error });
        const outcome = await this.runTeam(caller, team, ctx);
        if (!outcome.some(part => part.status === "completed")) {
          return JSON.stringify({ error: `No team member finished. ${outcome.map(part => `${part.agentId}: ${part.result}`).join(" ")}` });
        }
        return JSON.stringify({ ok: true, team: outcome.map(part => ({ agent: part.agentId, status: part.status, result: part.result.slice(0, 3000) })) });
      }

      default:
        return JSON.stringify({ error: `Unknown tool ${call.function.name}` });
    }
  }

  /**
   * Small models often misname hand-off arguments, e.g. {"task_id": "planner", "task_description": "..."}. Accept an existing
   * agent (id or name) under a few common keys and the text under a few more; otherwise say exactly what is missing.
   */
  private handoffArguments(caller: AgentDefinition, args: Record<string, unknown>, ctx: RunContext, tool: string, textKey: "question" | "instruction"): { targetId: string; text: string } | { error: string } {
    const agents = this.db.listAgents();
    const agentFrom = (value: unknown) => {
      if (typeof value !== "string") return undefined;
      const wanted = value.trim().replace(/^@/, "").toLowerCase();
      return agents.find(agent => agent.id.toLowerCase() === wanted || agent.name.toLowerCase() === wanted)?.id;
    };
    const targetId = [args.agent_id, args.agentId, args.agent, args.target, args.to, args.assignee, args.task_id].map(agentFrom).find(Boolean);
    const text = [args[textKey], args.instruction, args.question, args.task, args.task_description, args.description, args.prompt, args.message]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (targetId && text) return { targetId, text };
    const reachable = this.delegationTeam(caller, ctx).map(agent => agent.id).join(", ") || "none";
    const problem = !targetId
      ? (typeof args.agent_id === "string" && args.agent_id ? `"${args.agent_id}" is not an agent.` : "No agent was named.")
      : `The ${textKey} is missing.`;
    return { error: `${tool} needs "agent_id" (one of: ${reachable}) and "${textKey}". ${problem}` };
  }

  /** delegate_team's parts, accepting the same misnamed fields as a single hand-off and ignoring unknown "after" ids. */
  private teamArguments(caller: AgentDefinition, args: Record<string, unknown>, ctx: RunContext): TeamPlan | { error: string } {
    const raw = [args.tasks, args.team, args.parts, args.agents].find(Array.isArray) as unknown[] | undefined;
    if (!raw?.length) return { error: 'delegate_team needs "tasks": a list of {agent_id, instruction, after?}.' };
    const tasks: TeamPlanTask[] = [];
    for (const entry of raw.slice(0, 6)) {
      if (!entry || typeof entry !== "object") return { error: "Each delegate_team task must be an object with agent_id and instruction." };
      const part = this.handoffArguments(caller, entry as Record<string, unknown>, ctx, "delegate_team", "instruction");
      if ("error" in part) return { error: part.error };
      if (tasks.some(task => task.agent_id === part.targetId)) return { error: `${part.targetId} appears twice; give each agent one combined instruction.` };
      const entryArgs = entry as Record<string, unknown>;
      const after = [entryArgs.after, entryArgs.depends_on, entryArgs.dependsOn].find(Array.isArray) as unknown[] | undefined;
      tasks.push({ id: part.targetId, agent_id: part.targetId, instruction: part.text, depends_on: (after ?? []).map(String) });
    }
    // "after" may name an agent id or name; keep only members of this team (and never the part itself).
    const byName = (value: string) => tasks.find(task => task.agent_id === value.toLowerCase() || this.db.getAgent(task.agent_id)?.name.toLowerCase() === value.toLowerCase())?.id;
    for (const task of tasks) task.depends_on = [...new Set(task.depends_on.map(byName).filter((id): id is string => Boolean(id) && id !== task.id))];
    return { objective: tasks.map(task => task.instruction).join(" / ").slice(0, 6000), tasks };
  }

  private async delegate(
    caller: AgentDefinition,
    targetId: string,
    instruction: string,
    ctx: RunContext,
    mode: "ask" | "delegate"
  ): Promise<string> {
    // Any agent may consult another; handing over ownership of work needs the agent's can-delegate setting.
    if (mode === "delegate" && !caller.canDelegate) {
      return JSON.stringify({ error: `${caller.id} cannot delegate work; use ask_agent to consult another agent.` });
    }

    const maxDelegations = this.runtimeConfig.maxDelegationsPerTask;
    if (ctx.delegationCount + 1 > maxDelegations) {
      return JSON.stringify({ error: `Delegation count limit (${maxDelegations}) reached.` });
    }

    if (targetId === caller.id || ctx.ancestorAgents.includes(targetId)) {
      const reachable = this.delegationTeam(caller, ctx).map(agent => agent.id);
      const requester = ctx.ancestorAgents.at(-1);
      return JSON.stringify({
        error: `Delegation cycle prevented: ${[...ctx.ancestorAgents, caller.id, targetId].join(" -> ")}. ${targetId === caller.id ? "You cannot ask or delegate to yourself." : `${targetId} is already waiting on this request.`} ${reachable.length ? `Agents you can ask: ${reachable.join(", ")}.` : "No other agent is available."} To get information from the user, do not call a tool: answer with your assumptions and list your questions${requester ? `, and ${requester} will pass them on` : ""}.`
      });
    }

    const blocked = this.handoffBlocked(caller, targetId, ctx);
    if (blocked) return JSON.stringify({ error: blocked });
    const target = this.db.getAgent(targetId)!;
    this.agentRuns++;

    const childTaskId = randomUUID();
    this.db.addMessage(ctx.taskId, caller.id, targetId, mode, instruction);
    this.messageBus?.publish({ id: childTaskId, taskId: ctx.taskId, conversationId: ctx.conversationId, fromAgentId: caller.id, toAgentId: targetId, kind: mode, content: instruction });
    this.emit("delegate", caller.id, `${mode} -> ${target.name}: ${instruction}`, { targetAgentId: target.id, delegateMode: mode });

    const result = await this.runAgent(
      targetId,
      instruction,
      {
        rootTaskId: ctx.rootTaskId,
        taskId: childTaskId,
        depth: ctx.depth + 1,
        delegationCount: ctx.delegationCount + 1,
        ancestorAgents: [...ctx.ancestorAgents, caller.id],
        conversationId: ctx.conversationId,
        images: ctx.images,
        thinking: ctx.thinking,
        reasoningEffort: ctx.reasoningEffort,
        planMode: ctx.planMode,
        approvalMode: ctx.approvalMode,
        providerId: ctx.providerId,
        model: ctx.model
      },
      ctx.taskId
    );

    this.db.addMessage(childTaskId, targetId, caller.id, "response", result);
    this.messageBus?.publish({ id: randomUUID(), taskId: childTaskId, conversationId: ctx.conversationId, fromAgentId: targetId, toAgentId: caller.id, kind: "response", content: result });
    return JSON.stringify({
      ok: true,
      agent: targetId,
      mode,
      result
    });
  }

  private guard(agent: AgentDefinition, ctx: RunContext) {
    if (ctx.ancestorAgents.includes(agent.id)) {
      throw new Error(`Agent recursion detected for ${agent.id}`);
    }
  }

  private contextRecentMessages(): number {
    return this.runtimeConfig.contextRecentMessages;
  }

  private toolsAllowedFor(agent: AgentDefinition, ctx: RunContext) {
    const allowed = AGENT_TOOLS.filter(tool => {
      const name = tool.function.name;
      // Anyone may consult another agent; handing over work (alone or as a team) needs can-delegate.
      if (["delegate_task", "delegate_team"].includes(name) && !agent.canDelegate) return false;
      // Reading the workspace is read-only (risk 0); planners and the lead need it to describe or plan the project.
      const readProfiles = ["coder", "researcher", "general", "planner"];
      if (["search_workspace", "read_file", "file_outline"].includes(name) && !readProfiles.includes(agent.layaProfile || "general")) return false;
      if (name === "write_file" && agent.layaProfile !== "coder") return false;
      if (["remember_relation", "remember_entity"].includes(name) && !["coder", "researcher", "planner"].includes(agent.layaProfile || "general")) return false;
      return true;
    });
    // Hand-off tools only accept agents this agent can actually reach, so a model cannot pick itself.
    const targets = this.delegationTeam(agent, ctx).map(other => other.id);
    const constrained = allowed.flatMap((tool): Array<typeof tool> => {
      if (!HANDOFF_TOOLS.includes(tool.function.name)) return [tool];
      if (!targets.length) return [];
      const parameters = tool.function.parameters as { properties: Record<string, any> };
      const agentId = { type: "string", enum: targets, description: "The agent to hand this to. Never yourself or an agent that asked you." };
      const properties = tool.function.name === "delegate_team"
        ? { tasks: { ...parameters.properties.tasks, items: { ...parameters.properties.tasks.items, properties: { ...parameters.properties.tasks.items.properties, agent_id: agentId } } } }
        : { ...parameters.properties, agent_id: agentId };
      return [{ ...tool, function: { ...tool.function, parameters: { ...parameters, properties } } } as unknown as typeof tool];
    });
    return ctx.approvalMode === "full" ? [...constrained, ...FULL_ACCESS_TOOLS] : constrained;
  }

  /** Agents this one may ask or delegate to: never itself or an agent already waiting on it. Any agent may consult. */
  private delegationTeam(agent: AgentDefinition, ctx: RunContext): AgentDefinition[] {
    if (ctx.planMode || ctx.depth + 1 > this.runtimeConfig.maxDelegationDepth) return [];
    const blocked = new Set([agent.id, ...ctx.ancestorAgents]);
    return this.db.listAgents().filter(other => !blocked.has(other.id));
  }

  private filterByCategory(tools: any[], category: string) {
    const categories: Record<string, string[]> = {
      none: [],
      workspace_read: ["search_workspace", "file_outline", "read_file"],
      workspace_write: ["search_workspace", "file_outline", "read_file", "write_file"],
      memory: ["remember", "expand_tool_result"],
      knowledge_graph: ["remember_entity", "remember_relation"],
      planning: ["create_plan"],
      agent_communication: ["list_agents", "find_agent", "ask_agent", "delegate_task"],
      shell: ["run_command"]
    };
    const names = categories[category];
    if (!names) return tools;
    if (category === "none") return [];
    // Coordination is orthogonal to the current work category: a capable agent must
    // still be able to ask a specialist or hand off a subtask while doing focused work.
    // The tools have already been filtered for delegation permission and reachable agents.
    const coordination = HANDOFF_TOOLS;
    return tools.filter(tool => tool.function.name === "expand_tool_result" || names.includes(tool.function.name) || coordination.includes(tool.function.name));
  }

  private fitContext(messages: string[], memories: string[], entities: string[]) {
    // The target model's tokenizer isn't necessarily available in the extension host; use a conservative 3 chars/token estimate.
    let budget = Math.max(2_000, Math.min(60_000, (this.runtimeConfig.contextMaxTokens ?? 12_000) * 3));
    const takeRecent = (items: string[], perItemLimit: number) => {
      const kept: string[] = [];
      for (const item of [...items].reverse()) {
        if (budget <= 0) break;
        const text = item.slice(-perItemLimit);
        const accepted = text.slice(-budget);
        kept.unshift(accepted);
        budget -= accepted.length;
      }
      return kept;
    };
    const boundedMessages = takeRecent(messages, 8_000);
    const boundedMemories = takeRecent(memories, 1_500);
    const boundedEntities = takeRecent(entities, 500);
    return { messages: boundedMessages, memories: boundedMemories, entities: boundedEntities };
  }

  private buildSystemPrompt(
    agent: AgentDefinition,
    memories: string[],
    entities: string[],
    recentContext: string[],
    ctx: RunContext,
    instruction = ""
  ): string {
    return `${agent.systemPrompt}

You are agent "${agent.id}".
Skills: ${agent.skills.join(", ")}.

${this.workspaceSection(agent, ctx)}${this.teamSection(agent, ctx, instruction)}Delegation rules:
- You decide who to involve: nobody, one agent, or several. Solve tasks yourself when you are capable.
- Use find_agent when you need a specialist but do not know the agent ID.
- Use ask_agent for a focused consultation; any agent can ask any other.
- Use delegate_task when one agent should own a meaningful subtask.
- Use delegate_team to give parts to several agents at once: independent parts run in parallel, and "after" makes a part wait for others' results (a reviewer after the coder).
- You can call more agents after you see results, as often as the work needs.
- Do not delegate merely to repeat your own work.
- Integrate delegated results into your own final answer.
- Never invent tool results.
- Avoid delegation loops.

Runtime:
- delegation depth: ${ctx.depth}
- ancestor agents: ${ctx.ancestorAgents.join(" -> ") || "(none)"}
${ctx.ancestorAgents.length ? `- You are working for ${ctx.ancestorAgents.at(-1)}, not talking to the user. You cannot ask the user anything. If details are missing, make reasonable assumptions, state them, and list open questions in your answer.\n` : ""}${ctx.thinking ? `\nReasoning preference: use ${ctx.reasoningEffort || "medium"} effort to reason privately, then give a concise answer with the key rationale. Do not reveal private chain-of-thought.` : ""}
${ctx.planMode ? "\nPlan mode is active. Analyze the request and return a clear ordered plan. Do not implement changes, delegate work, or modify memory. You may save the plan with create_plan." : ""}

Relevant persistent memory:
${memories.length ? memories.map(m => `- ${m}`).join("\n") : "(none)"}

Relevant entities:
${entities.length ? entities.map(e => `- ${e}`).join("\n") : "(none)"}

Recent conversation context:
${recentContext.length ? recentContext.join("\n") : "(none)"}`;
  }

  /** Agents that can read the workspace look there first instead of asking the user for details they can find. */
  private workspaceSection(agent: AgentDefinition, ctx: RunContext): string {
    const reads = this.toolsAllowedFor(agent, ctx).some(tool => tool.function.name === "search_workspace" || tool.function.name === "read_file");
    if (!reads || ctx.planMode) return "";
    return `Workspace:
- "The project", "this code", "the repo" and similar mean the workspace that is open in the editor.
- Look before you ask: use search_workspace and read_file (start with README.md, package.json or the main entry point) to learn what the project is.
- Copy exact workspace-relative paths from search results or directory outlines. Do not guess filenames or assume a root src/ directory exists.
- Only ask the user for things the workspace cannot tell you, and say what you already found.

`;
  }

  /**
   * Who the agent can hand work to, so delegation is one step instead of a find_agent guess.
   * Agents with the "delegation" skill (the coordinator) are also told how to run a team, with a suggested one for
   * the request. It is advice: the agent decides who to call, how many, and in what order.
   */
  private teamSection(agent: AgentDefinition, ctx: RunContext, instruction: string): string {
    const team = this.delegationTeam(agent, ctx);
    if (!team.length) return "";
    const roster = team.map(other => `- ${other.id}: ${other.name} (${other.description})`).join("\n");
    const tools = agent.canDelegate ? "ask_agent, delegate_task or delegate_team" : "ask_agent";
    const coordinates = agent.canDelegate && agent.skills.some(skill => skill.toLowerCase() === "delegation");
    const suggested = coordinates && ctx.depth === 0 ? fallbackTeamPlan(instruction, team.map(other => other.id), agent.id) : undefined;
    const suggestion = suggested
      ? `\nSuggested team for this request (adjust it as you see fit): ${suggested.tasks.map(task => `${task.agent_id}${task.depends_on.length ? ` after ${task.depends_on.join(", ")}` : ""}`).join("; ")}.`
      : "";
    const coordinator = coordinates
      ? `\nYou coordinate the team. When a request spans several specialties (for example code, infrastructure, research, review), give the parts to the matching specialists in one delegate_team call so they work in parallel, have the reviewer check changes after the parts it reviews, then combine the results into one answer. When a request belongs to one specialist's area, delegate it to that specialist instead of doing it yourself. Answer directly only quick questions and coordination.${suggestion}\n`
      : "";
    return `Team you can call (use these ids with ${tools}):\n${roster}\n${coordinator}\n`;
  }

  private emit(type: RunEvent["type"], agentId: string, text: string, metadata: Partial<RunEvent> = {}) {
    this.onEvent?.({ type, agentId, text, rootTaskId: this.rootTaskId, ...metadata });
  }
}
