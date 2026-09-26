import { AgentDefinition, AgentDecision, AgentState, DecisionValue } from "./types";

export type DecisionPolicy = "global" | "coder" | "researcher" | "planner" | "general";

/** One shared, replaceable decision runtime. The deterministic baseline keeps the extension useful without a second model. */
export class LayaRuntime {
  decide(state: AgentState, policy: DecisionPolicy, agents: AgentDefinition[]): AgentDecision {
    const text = state.message.toLowerCase();
    const value = (v: string | boolean, confidence: number, reason: string): DecisionValue => ({ value: v, confidence, reason });
    const has = (...terms: string[]) => terms.some(term => text.includes(term));
    const target = policy === "global"
      ? (has("research", "investigate", "compare", "look up", "source") ? "researcher" : has("plan", "roadmap", "break down", "sequence") ? "lead" : has("database", "sql", "schema", "migration") ? "database" : has("review", "audit", "test") ? "reviewer" : "coder")
      : state.agentId;
    const confidence = target === "coder" && has("code", "implement", "fix", "refactor", "build") ? .94 : .82;
    const needsMemory = has("again", "existing", "project", "repository", "previous", "remember") || Boolean(state.recentContextSummary);
    const needsGraph = has("relationship", "dependency", "architecture", "schema", "entity");
    const needsVector = has("similar", "historical", "related", "previous");
    const tool = has("file", "code", "repository", "inspect") ? "search_code" : "none";
    return {
      agent: value(target, confidence, `Selected from request intent across ${agents.length} available agents.`),
      needsMemory: value(needsMemory, needsMemory ? .88 : .93, "Project context is useful only when the request references existing state."),
      needsGraph: value(needsGraph, needsGraph ? .82 : .9, "Graph retrieval is useful for explicit entity or dependency questions."),
      needsVector: value(needsVector, needsVector ? .78 : .9, "Semantic retrieval is reserved for historical or similarity requests."),
      needsLlm: value(true, .96, "The main model performs synthesis and tool-loop reasoning."),
      tool: value(tool, tool === "none" ? .86 : .78, "Tool category selected from the request."),
      delegate: value("self", .8, "The orchestrator lets the main agent decide whether delegation is needed.")
    };
  }
}

export class AgentDecisionEngine {
  constructor(private readonly runtime = new LayaRuntime()) {}
  decide(agent: AgentDefinition, state: AgentState, agents: AgentDefinition[]): AgentDecision {
    return this.runtime.decide(state, (agent.layaProfile as DecisionPolicy | undefined) ?? "general", agents);
  }
  route(state: AgentState, agents: AgentDefinition[]): AgentDecision { return this.runtime.decide(state, "global", agents); }
}

export function decisionMode(confidence: number): "execute" | "enrich" | "reason" {
  if (confidence >= .9) return "execute";
  if (confidence >= .65) return "enrich";
  return "reason";
}
