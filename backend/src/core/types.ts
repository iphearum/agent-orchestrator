export type AgentStatus =
  | "idle"
  | "thinking"
  | "running"
  | "delegating"
  | "waiting"
  | "completed"
  | "failed";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  /** Optional provider connection to use instead of the global active provider. */
  providerId?: string;
  model?: string;
  /** Optional n8n webhook connection for agents hosted outside this extension. */
  n8nLinkId?: string;
  /** Optional WebSocket connection for persistent remote agent runtimes. */
  socketLinkId?: string;
  /** Optional coding-agent CLI (agentOrchestrator.cliAgents) that runs this agent's tasks, e.g. Claude Code or Codex. */
  cliLinkId?: string;
  status?: AgentStatus;
  canDelegate: boolean;
  layaProfile?: string;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatImageAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  thinkingText?: string | null;
}

export interface RunContext {
  rootTaskId: string;
  taskId: string;
  depth: number;
  delegationCount: number;
  ancestorAgents: string[];
  conversationId?: string;
  images?: ChatImageAttachment[];
  thinking?: boolean;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  planMode?: boolean;
  /** The client asked a question: answer it and leave the workspace unchanged. Inherited by every delegated agent. */
  answerOnly?: boolean;
  approvalMode?: "ask" | "approve" | "full";
  providerId?: string;
  model?: string;
  /** The task row already exists because the Laya team plan was persisted before scheduling. */
  existingTask?: boolean;
}

export type MemoryType = "working" | "episodic" | "semantic" | "procedural" | "profile";

export interface AgentState {
  agentId: string;
  agentName: string;
  message: string;
  currentTask?: { id: string; instruction: string; status: string };
  activePlan?: { id: string; objective: string; status: string };
  availableTools: string[];
  recentContextSummary?: string;
  relevantEntities?: string[];
  teamPlanRequest?: { objective: string; maxTasks: number; agents: Array<{ id: string; name: string; description: string; skills: string[] }> };
}

export interface DecisionValue {
  value: string | boolean;
  confidence: number;
  reason?: string;
}

export interface AgentDecision {
  agent?: DecisionValue;
  needsMemory: DecisionValue;
  needsGraph: DecisionValue;
  needsVector: DecisionValue;
  needsLlm: DecisionValue;
  tool: DecisionValue;
  delegate?: DecisionValue;
  retrievalSource?: DecisionValue;
  source?: "laya" | "rules" | "none";
  routing?: unknown;
  teamPlan?: { objective: string; tasks: Array<{ id: string; agent_id: string; instruction: string; depends_on: string[] }> };
  fallbackReason?: string;
}

export type TraceKind = "decision" | "routing" | "retrieval" | "context" | "model" | "tool" | "memory" | "jev" | "error";
