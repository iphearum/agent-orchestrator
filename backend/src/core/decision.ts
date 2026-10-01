import { AgentDefinition, AgentDecision, AgentState, DecisionValue } from "./types";
import { LayaHttpClient } from "../integrations/layaClient";

export type DecisionPolicy = "global" | "coder" | "researcher" | "planner" | "general";

/** One shared, replaceable decision runtime. The deterministic baseline keeps the extension useful without a second model. */
export class LayaRuntime {
  decide(state: AgentState, policy: DecisionPolicy, agents: AgentDefinition[]): AgentDecision {
    const text = state.message.toLowerCase();
    const value = (v: string | boolean, confidence: number, reason: string): DecisionValue => ({ value: v, confidence, reason });
    const has = (...terms: string[]) => terms.some(term => text.includes(term));
    // "Hey lead, …", "@planner …": the user addressed an agent by id or name.
    const addressed = (() => {
      const mention = text.match(/@([a-z][\w-]*)/)?.[1] ?? text.match(/^\s*(?:(?:hey|hi|hello|ok|okay|dear)\s+)?([a-z][\w-]*)\s*[,:!]/)?.[1];
      return mention ? agents.find(agent => agent.id.toLowerCase() === mention || agent.name.toLowerCase() === mention)?.id : undefined;
    })();
    const target = policy === "global"
      ? addressed ?? (has("research", "investigate", "compare", "look up", "source", "architecture", "structure", "project overview") ? "researcher" : has("plan", "roadmap", "break down", "sequence") ? "lead" : has("database", "sql", "schema", "migration") ? "database" : has("review", "audit", "test") ? "reviewer" : has("document", "readme", "docs", "write-up", "guide") && agents.some(agent => agent.id === "documenter") ? "documenter" : has("deploy", "pipeline", "docker", "ci/cd", "infrastructure") && agents.some(agent => agent.id === "devops") ? "devops"
        // Coder only for coding words; with no clear intent the request stays with the agent the user is talking to.
        : has("code", "implement", "fix", "bug", "refactor", "function", "compile", "error") ? "coder" : state.agentId)
      : state.agentId;
    const confidence = target === "coder" && has("code", "implement", "fix", "refactor", "build") ? .94 : .82;
    const needsMemory = has("again", "existing", "project", "repository", "previous", "remember") || Boolean(state.recentContextSummary);
    const needsGraph = has("relationship", "dependency", "architecture", "schema", "entity");
    const needsVector = has("similar", "historical", "related", "previous");
    const tool = has("file", "code", "repository", "inspect", "search", "read") ? "workspace_read"
      : has("plan", "roadmap", "steps", "sequence") ? "planning"
        : has("delegate", "ask another", "specialist", "agent") ? "agent_communication"
          : has("relationship", "entity", "graph") ? "knowledge_graph"
            : has("remember", "memory") ? "memory" : "none";
    return {
      agent: value(target, confidence, `Selected from request intent across ${agents.length} available agents.`),
      needsMemory: value(needsMemory, needsMemory ? .88 : .93, "Project context is useful only when the request references existing state."),
      needsGraph: value(needsGraph, needsGraph ? .82 : .9, "Graph retrieval is useful for explicit entity or dependency questions."),
      needsVector: value(needsVector, needsVector ? .78 : .9, "Semantic retrieval is reserved for historical or similarity requests."),
      needsLlm: value(true, .96, "The main model performs synthesis and tool-loop reasoning."),
      // No keyword is not evidence that no tool is needed: stay unsure so the gate keeps the agent's tools.
      tool: value(tool, tool === "none" ? .5 : .78, tool === "none" ? "No tool keyword in the request; the agent keeps its eligible tools." : "Tool category selected from the request."),
      delegate: value("self", .8, "The orchestrator lets the main agent decide whether delegation is needed.")
    };
  }
}

export class AgentDecisionEngine {
  constructor(private readonly runtime = new LayaRuntime(), private readonly laya?: LayaHttpClient, private readonly fallbackMode: "none" | "rules" = "none") {}

  async decide(agent: AgentDefinition, state: AgentState, agents: AgentDefinition[]): Promise<AgentDecision> {
    return this.decideWithPolicy(state, (agent.layaProfile as DecisionPolicy | undefined) ?? "general", agents);
  }

  async route(state: AgentState, agents: AgentDefinition[]): Promise<AgentDecision> {
    return this.decideWithPolicy(state, "global", agents);
  }

  private async decideWithPolicy(state: AgentState, policy: DecisionPolicy, agents: AgentDefinition[]): Promise<AgentDecision> {
    if (this.laya) {
      try {
        const result = await this.laya.decide(state, policy, agents);
        const from = (value: { value: string | boolean; confidence: number }, reason: string): DecisionValue => ({ ...value, reason });
        // Laya is asked only what the runtime acts on; the rest are fixed, and the trace says they weren't asked.
        const notAsked = (value: string | boolean, why: string): DecisionValue => ({ value, confidence: 1, reason: `Not asked: ${why}` });
        const routing = policy === "global";
        return {
          ...(result.agent ? { agent: from(result.agent, "Selected by the configured Laya API.") } : {}),
          needsMemory: result.needsMemory ? from(result.needsMemory, "Laya decision.") : notAsked(false, routing ? "the routed agent decides retrieval." : "no answer."),
          needsGraph: result.needsGraph ? from(result.needsGraph, "Laya decision.") : notAsked(false, routing ? "the routed agent decides retrieval." : "no answer."),
          needsVector: notAsked(false, "vector retrieval is not enabled."),
          needsLlm: notAsked(true, "the main model always handles the request."),
          tool: result.tool ? from(result.tool, "Laya selected the first capability category to consider.") : notAsked("none", "the routed agent chooses its tools."),
          delegate: notAsked("self", "the agent's model delegates through its tools when permitted."),
          source: "laya",
          routing: result.routing,
          teamPlan: result.teamPlan
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return this.fallback(state, policy, agents, `Laya unavailable: ${reason}`);
      }
    }
    return this.fallback(state, policy, agents, "Laya endpoint is not configured.");
  }

  private fallback(state: AgentState, policy: DecisionPolicy, agents: AgentDefinition[], reason: string): AgentDecision {
    if (this.fallbackMode === "rules") return { ...this.runtime.decide(state, policy, agents), source: "rules", fallbackReason: reason };
    const no = (why: string): DecisionValue => ({ value: false, confidence: 1, reason: why });
    return {
      agent: { value: state.agentId, confidence: 0, reason: "No-Laya mode keeps the configured root agent." },
      needsMemory: no("No-Laya mode skips optional memory retrieval."),
      needsGraph: no("No-Laya mode skips optional knowledge graph retrieval."),
      needsVector: no("No-Laya mode skips optional vector retrieval."),
      needsLlm: { value: true, confidence: 1, reason: "The main model still handles the user request." },
      tool: { value: "none", confidence: 1, reason: "No-Laya mode does not request extra tools." },
      delegate: no("The main agent may still delegate through its model tools when permitted."),
      source: "none",
      fallbackReason: reason
    };
  }
}

export function decisionMode(confidence: number, automaticThreshold = .9, enrichmentThreshold = .65): "execute" | "enrich" | "reason" {
  if (confidence >= automaticThreshold) return "execute";
  if (confidence >= enrichmentThreshold) return "enrich";
  return "reason";
}
