import { randomUUID } from "crypto";
import { AgentDatabase } from "./database";
import { OpenAICompatibleModel } from "./model";
import { AGENT_TOOLS, FULL_ACCESS_TOOLS } from "./tools";
import { AgentDefinition, AgentMessage, ChatImageAttachment, RunContext, ToolCall } from "./types";
import { AgentDecisionEngine } from "./decision";

export interface RunEvent {
  type: "start" | "message" | "delegate" | "tool" | "result" | "error";
  agentId: string;
  text: string;
}

export interface OrchestratorConfig {
  layaEnabled: boolean;
  maxDelegationDepth: number;
  maxDelegationsPerTask: number;
  contextRecentMessages: number;
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
}

export interface ToolApprovalRequest { agentId: string; agentName: string; toolName: string; argumentsJson: string; }
export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export class Orchestrator {
  constructor(
    private db: AgentDatabase,
    private model: OpenAICompatibleModel,
    private onEvent?: (e: RunEvent) => void,
    private decisions = new AgentDecisionEngine(),
    private runtimeConfig: OrchestratorConfig = { layaEnabled: true, maxDelegationDepth: 3, maxDelegationsPerTask: 8, contextRecentMessages: 6 },
    private requestToolApproval?: ToolApprovalHandler,
    private runFullAccessCommand?: (command: string) => Promise<string>
  ) {}

  async runRoot(instruction: string, rootAgentId = "lead", autoRoute = true, options: ChatRunOptions = {}): Promise<string> {
    const rootTaskId = randomUUID();
    const conversationId = options.conversationId || randomUUID();
    if (!this.db.hasConversation(conversationId)) this.db.createConversation(conversationId, options.title || instruction);
    const newImageNames = options.attachedImageNames || [];
    const imageNote = newImageNames.length ? `\n[${newImageNames.length} image${newImageNames.length === 1 ? "" : "s"} attached: ${newImageNames.join(", ")}]` : "";
    this.db.addConversationMessage(randomUUID(), conversationId, null, "user", (options.displayPrompt || instruction) + imageNote);
    const available = this.db.listAgents();
    const route = autoRoute && this.runtimeConfig.layaEnabled
      ? this.decisions.route({ agentId: rootAgentId, agentName: "global", message: instruction, availableTools: [] }, available)
      : { agent: { value: rootAgentId, confidence: 1 } } as ReturnType<AgentDecisionEngine["route"]>;
    const routedAgent = typeof route.agent?.value === "string" ? route.agent.value : rootAgentId;
    const selected = this.db.getAgent(routedAgent) ? routedAgent : rootAgentId;
    this.db.trace(conversationId, rootTaskId, selected, "routing", route);

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
      approvalMode: options.approvalMode
    });
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

    if (ctx.depth === 0) {
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

    const localDecision = this.decisions.decide(agent, {
      agentId,
      agentName: agent.name,
      message: instruction,
      currentTask: { id: ctx.taskId, instruction, status: "active" },
      activePlan: this.db.activePlan(ctx.taskId),
      availableTools: AGENT_TOOLS.map(tool => tool.function.name),
      recentContextSummary: ctx.conversationId ? this.db.recentMessages(ctx.conversationId, this.contextRecentMessages()).join("\n") : undefined,
      relevantEntities: this.db.findEntities(instruction)
    }, this.db.listAgents());
    const memories = localDecision.needsMemory.value === true ? this.db.recentMemories(agentId) : [];
    const entities = localDecision.needsGraph.value === true ? this.db.findEntities(instruction) : [];
    const recentContext = ctx.conversationId ? this.db.recentMessages(ctx.conversationId, this.contextRecentMessages()) : [];
    this.db.trace(ctx.conversationId, ctx.taskId, agentId, "decision", localDecision);
    const userContent: AgentMessage["content"] = ctx.images?.length
      ? [
          { type: "text", text: instruction },
          ...ctx.images.map(image => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))
        ]
      : instruction;
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: this.buildSystemPrompt(agent, memories, entities, recentContext, ctx)
      },
      { role: "user", content: userContent }
    ];

    try {
      for (let turn = 0; turn < 20; turn++) {
        const modeTools = ctx.approvalMode === "full" ? [...AGENT_TOOLS, ...FULL_ACCESS_TOOLS] : AGENT_TOOLS;
        const availableTools = ctx.planMode
          ? modeTools.filter(tool => tool.function.name === "create_plan")
          : agent.canDelegate ? modeTools : modeTools.filter(tool =>
            !["ask_agent", "delegate_task"].includes(tool.function.name)
          );
        const response = await this.model.chat(messages, availableTools, agent.model);

        if (response.content) {
          messages.push({ role: "assistant", content: response.content ?? "" });
          this.db.addMessage(ctx.taskId, agentId, null, "assistant", response.content);
          if (ctx.conversationId) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, "assistant", response.content);
          this.emit("message", agentId, response.content);
        }

        if (!response.toolCalls.length) {
          const finalResult = response.content ?? "(no result)";
          this.db.completeTask(ctx.taskId, finalResult);
          if (!ctx.planMode) this.db.remember(agentId, "private", `Completed task: ${instruction}\nResult: ${finalResult.slice(0, 1800)}`, "episodic", ctx.conversationId);
          if (ctx.conversationId && ctx.depth === 0) this.db.addConversationMessage(randomUUID(), ctx.conversationId, agentId, "result", finalResult);
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
          const approvalRequired = ctx.approvalMode === "ask" && ["ask_agent", "delegate_task", "remember", "remember_entity"].includes(call.function.name);
          let result: string;
          if (approvalRequired) {
            this.emit("tool", agentId, `Waiting for approval: ${call.function.name}`);
            const approved = await this.requestToolApproval?.({ agentId, agentName: agent.name, toolName: call.function.name, argumentsJson: call.function.arguments }) ?? false;
            result = approved ? await this.executeTool(agent, call, ctx) : JSON.stringify({ error: "The user declined this action. Continue without it." });
          } else {
            this.emit("tool", agentId, `Using ${call.function.name}`);
            result = await this.executeTool(agent, call, ctx);
          }
          this.db.recordToolRun(ctx.conversationId, agentId, call.function.name, call.function.arguments, result);
          this.db.trace(ctx.conversationId, ctx.taskId, agentId, "tool", { name: call.function.name, result });

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: result
          });
        }
      }

      throw new Error("Agent exceeded maximum reasoning/tool turns.");
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
          String(args.content)
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
        const entityId = randomUUID();
        this.db.upsertEntity(entityId, String(args.type), String(args.name), args.data ?? {});
        return JSON.stringify({ ok: true, entity_id: entityId });
      }

      case "ask_agent":
        return this.delegate(
          caller,
          String(args.agent_id),
        `Consultation request from ${caller.name}:\n${String(args.question)}`,
          ctx,
          "ask"
        );

      case "delegate_task":
        return this.delegate(
          caller,
          String(args.agent_id),
          String(args.instruction),
          ctx,
          "delegate"
        );

      default:
        return JSON.stringify({ error: `Unknown tool ${call.function.name}` });
    }
  }

  private async delegate(
    caller: AgentDefinition,
    targetId: string,
    instruction: string,
    ctx: RunContext,
    mode: "ask" | "delegate"
  ): Promise<string> {
    if (!caller.canDelegate) {
      return JSON.stringify({ error: `${caller.id} cannot delegate.` });
    }

    const maxDepth = this.runtimeConfig.maxDelegationDepth;
    const maxDelegations = this.runtimeConfig.maxDelegationsPerTask;

    if (ctx.depth + 1 > maxDepth) {
      return JSON.stringify({ error: `Delegation depth limit (${maxDepth}) reached.` });
    }

    if (ctx.delegationCount + 1 > maxDelegations) {
      return JSON.stringify({ error: `Delegation count limit (${maxDelegations}) reached.` });
    }

    if (targetId === caller.id || ctx.ancestorAgents.includes(targetId)) {
      return JSON.stringify({
        error: `Delegation cycle prevented: ${[...ctx.ancestorAgents, caller.id, targetId].join(" -> ")}`
      });
    }

    const target = this.db.getAgent(targetId);
    if (!target) {
      return JSON.stringify({ error: `Agent '${targetId}' does not exist.` });
    }

    const childTaskId = randomUUID();
    this.db.addMessage(ctx.taskId, caller.id, targetId, mode, instruction);
    this.emit("delegate", caller.id, `${mode} -> ${target.name}: ${instruction}`);

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
        approvalMode: ctx.approvalMode
      },
      ctx.taskId
    );

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

  private buildSystemPrompt(
    agent: AgentDefinition,
    memories: string[],
    entities: string[],
    recentContext: string[],
    ctx: RunContext
  ): string {
    return `${agent.systemPrompt}

You are agent "${agent.id}".
Skills: ${agent.skills.join(", ")}.

Delegation rules:
- Solve tasks yourself when you are capable.
- Use find_agent when you need a specialist but do not know the agent ID.
- Use ask_agent for a focused consultation.
- Use delegate_task when another agent should own a meaningful subtask.
- Do not delegate merely to repeat your own work.
- You may delegate further when permitted.
- Integrate delegated results into your own final answer.
- Never invent tool results.
- Avoid delegation loops.

Runtime:
- delegation depth: ${ctx.depth}
- ancestor agents: ${ctx.ancestorAgents.join(" -> ") || "(none)"}
${ctx.thinking ? `\nReasoning preference: use ${ctx.reasoningEffort || "medium"} effort to reason privately, then give a concise answer with the key rationale. Do not reveal private chain-of-thought.` : ""}
${ctx.planMode ? "\nPlan mode is active. Analyze the request and return a clear ordered plan. Do not implement changes, delegate work, or modify memory. You may save the plan with create_plan." : ""}

Relevant persistent memory:
${memories.length ? memories.map(m => `- ${m}`).join("\n") : "(none)"}

Relevant entities:
${entities.length ? entities.map(e => `- ${e}`).join("\n") : "(none)"}

Recent conversation context:
${recentContext.length ? recentContext.join("\n") : "(none)"}`;
  }

  private emit(type: RunEvent["type"], agentId: string, text: string) {
    this.onEvent?.({ type, agentId, text });
  }
}
