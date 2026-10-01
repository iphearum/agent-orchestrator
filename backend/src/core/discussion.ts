import type { AgentDefinition, AgentMessage, ChatImageAttachment, ChatResponse } from "./types";
import { OpenAICompatibleModel, type AgentModelSelection, type ProviderReasoningEffort } from "./model";
import { SessionRepository } from "../storage/repositories/sessions";
import { resolveReasoning, type ReasoningEffort, type ThinkingMode } from "./reasoning";
import type { DiscussionDecision, DiscussionDecisionInput } from "../decision/policies/discussion";

export interface DiscussionOptions extends AgentModelSelection {
  agentId: string;
  /** Auto thinks only when the message looks hard; On always thinks; Off never adds reasoning on its own. */
  thinking?: ThinkingMode;
  supervisorDiscussion?: boolean;
  agents?: AgentDefinition[];
  attachments?: Array<{ name: string; content: string }>;
  images?: ChatImageAttachment[];
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
  onConsultation?: (agentId: string, advice?: string) => void;
  /**
   * Laya's discussion policy (or its fallback): effort and whether the Supervisor should consult. Without it the
   * word-pattern estimate is used and the Supervisor's model alone decides whether to consult.
   */
  decide?: (input: DiscussionDecisionInput) => Promise<DiscussionDecision>;
  /** Called once when the effort was chosen automatically, so the UI can say the agent is thinking harder and why. */
  onEffort?: (effort: DiscussionEffort, decision?: DiscussionDecision) => void;
  /** Called when streamed text from the deciding call is superseded by a reply that uses specialist advice. */
  onStreamReset?: () => void;
}

export type DiscussionEffort = ReasoningEffort;
type SentEffort = ProviderReasoningEffort | undefined;
export { estimateDiscussionEffort } from "./reasoning";

const DISCUSSION_SYSTEM = [
  "You are helping a client define a task for an agent team.",
  "Discuss goals, constraints, acceptance criteria, and who may need to work on it.",
  "Answer greetings and small talk briefly and naturally, then invite the client to describe what they want done.",
  "Ask focused questions when important details are missing. Summarize agreed decisions clearly.",
  "This is a discussion only. You have no tools and must not claim that agents started work, files changed, or a task was assigned.",
  "The client will explicitly choose Assign task when ready."
].join(" ");

const ALL_ADVISORS = /\b(?:ask|consult|include|hear from)?\s*(?:all|every|each|entire)\s+(?:available\s+)?(?:agents?|specialists?|team)\b|\b(?:agents?|specialists?|team)\s+(?:all|everyone)\b/i;
const STOP_WORDS = new Set("about after again also any are ask be before can check client could each for from give good have hello help here hey how into just like me more morning most need not of our please should some thank thanks that the their them then there these they this through want what when where which with would you your".split(" "));
const ADVISOR_TERMS: Record<string, string[]> = {
  researcher: ["research", "investigate", "compare", "evidence", "history", "recommend", "project", "analysis", "analyze", "chat"],
  coder: ["code", "implementation", "feature", "chat", "interface", "design", "webview", "component", "frontend", "backend"],
  database: ["database", "sqlite", "storage", "schema", "history", "memory", "knowledge", "logs", "conversation", "search"],
  reviewer: ["review", "quality", "security", "risk", "recommend", "project", "architecture", "chat", "history"],
  planner: ["plan", "workflow", "process", "roadmap", "goals", "architecture", "improvement", "team"],
  devops: ["build", "deploy", "deployment", "release", "pipeline", "configuration", "infrastructure", "error"],
  documenter: ["document", "documentation", "readme", "guide", "instructions"]
};

/** Choose a small advisory group for a Supervisor discussion, or the full roster when the client asks for it. */
export function selectDiscussionAdvisors(prompt: string, agents: AgentDefinition[]): AgentDefinition[] {
  const available = agents.filter(agent => agent.id !== "lead");
  if (!available.length) return [];
  if (ALL_ADVISORS.test(prompt)) return available;

  const words = new Set((prompt.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !STOP_WORDS.has(word)));
  const ranked = available.map((agent, index) => {
    const profile = new Set(`${agent.name} ${agent.description} ${agent.skills.join(" ")}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const overlap = [...words].filter(word => profile.has(word)).length;
    const roleMatches = (ADVISOR_TERMS[agent.id] ?? []).filter(term => words.has(term)).length;
    return { agent, index, score: overlap * 2 + roleMatches * 3 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  // Greetings and small talk match no specialist; the Supervisor answers them directly instead of waiting on advisers.
  return ranked.slice(0, 3).map(item => item.agent);
}

function consultTool(agents: AgentDefinition[]) {
  return {
    type: "function",
    function: {
      name: "consult_agents",
      description: "Ask specialist agents for advice before you reply. Use it only when the client's message needs expertise you lack or a real trade-off to weigh; never for greetings, small talk, or questions you can answer well yourself.",
      parameters: {
        type: "object",
        properties: {
          agents: { type: "array", items: { type: "string", enum: agents.map(agent => agent.id) }, maxItems: 3, description: "The 1-3 most relevant specialists." },
          question: { type: "string", description: "The focused question each specialist should advise on." }
        },
        required: ["agents"]
      }
    }
  };
}

/** Read the Supervisor's consult_agents call; unknown agents are dropped and at most three are kept. */
function requestedConsultation(response: ChatResponse, agents: AgentDefinition[]): { advisors: AgentDefinition[]; question?: string } | undefined {
  const call = response.toolCalls.find(item => item.function.name === "consult_agents");
  if (!call) return undefined;
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    const ids: unknown[] = Array.isArray(args.agents) ? args.agents : [];
    const advisors = agents.filter(agent => ids.includes(agent.id)).slice(0, 3);
    return { advisors, question: typeof args.question === "string" ? args.question.slice(0, 1000) : undefined };
  } catch {
    return { advisors: [] };
  }
}

async function runConsultations(
  agents: AgentDefinition[],
  discussion: AgentMessage[],
  options: DiscussionOptions,
  model: OpenAICompatibleModel,
  reasoningEffort: SentEffort,
  question?: string
): Promise<Array<{ agent: AgentDefinition; advice: string }>> {
  if (!agents.length) return [];
  const history = discussion.slice(1, -1).slice(-8);
  const userMessage = discussion.at(-1)!;
  const results: Array<{ agent: AgentDefinition; advice: string } | undefined> = new Array(agents.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < agents.length) {
      const index = cursor++;
      const agent = agents[index];
      options.onConsultation?.(agent.id);
      const system = [
        agent.systemPrompt,
        `You are being consulted by Supervisor before the client assigns work. Your role: ${agent.description}`,
        `Relevant skills: ${agent.skills.join(", ") || "general"}.`,
        "Give a concise recommendation based only on the client's message, discussion and supplied attachments.",
        "You have no tools and have not inspected the workspace. Do not claim to have read files, changed anything, or started a task. State assumptions and ask at most one useful clarification.",
        question ? `Supervisor's question for you: ${question}` : ""
      ].filter(Boolean).join(" ");
      try {
        const response = await model.chat([
          { role: "system", content: system },
          ...history,
          userMessage
        ], [], {
          providerId: agent.providerId ?? options.providerId,
          model: agent.model ?? options.model,
          reasoningEffort
        });
        const advice = response.content?.trim();
        if (advice) {
          results[index] = { agent, advice: advice.slice(0, 2400) };
          options.onConsultation?.(agent.id, advice.slice(0, 2400));
        }
      } catch {
        // One unavailable adviser should not block the client discussion or the other agents.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, agents.length) }, worker));
  return results.filter((result): result is { agent: AgentDefinition; advice: string } => !!result);
}

/** Tool-free conversation before the client explicitly assigns an agent task. */
export class DiscussionService {
  constructor(private readonly model: OpenAICompatibleModel, private readonly sessions: SessionRepository) {}

  async reply(conversationId: string, prompt: string, options: DiscussionOptions): Promise<string> {
    const history = this.sessions.messages(conversationId, 12)
      .filter(message => !message.trace?.failed)
      .map(message => ({
        role: message.role === "user" ? "user" : "assistant",
        content: message.text.slice(0, 4000)
      } as AgentMessage));
    const attachments = (options.attachments ?? []).map(file => `\n\n--- Attached file: ${file.name} ---\n${file.content.slice(0, 12000)}`).join("");
    const content = prompt + attachments;
    const images = options.images ?? [];
    const userContent: AgentMessage["content"] = images.length
      ? [{ type: "text", text: content }, ...images.map(image => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))]
      : content;
    this.sessions.addDiscussionMessage(conversationId, null, "user", prompt);
    const messages: AgentMessage[] = [
      { role: "system", content: DISCUSSION_SYSTEM },
      ...history,
      { role: "user", content: userContent }
    ];
    const agents = (options.agents ?? []).filter(agent => agent.id !== "lead");
    const askAll = ALL_ADVISORS.test(prompt);
    // Laya is asked only when its answer is used: an automatic effort, or the Supervisor deciding whether to consult.
    const needsEffort = options.thinking !== "off" && !options.reasoningEffort;
    const needsConsult = Boolean(options.supervisorDiscussion) && !askAll && agents.length > 0;
    const decision = options.decide && (needsEffort || needsConsult)
      ? await options.decide({ prompt, supervisor: needsConsult, effort: needsEffort, attachments: options.attachments?.length, images: images.length, recentContext: history.slice(-4).map(message => String(message.content)).join("\n").slice(-1200) })
      : undefined;
    const reasoning = resolveReasoning(prompt, { thinking: options.thinking, reasoningEffort: options.reasoningEffort, attachments: options.attachments?.length, images: images.length, estimate: decision?.effort.value });
    if (reasoning.estimated) options.onEffort?.(reasoning.estimated, decision);
    const { reasoningEffort } = reasoning;
    const selection = { providerId: options.providerId, model: options.model, reasoningEffort };
    const finalReply = async (system: string, advisors: AgentDefinition[], question?: string) => {
      const consultations = await runConsultations(advisors, messages, options, this.model, reasoningEffort, question);
      const consultationContext = consultations.length
        ? `\n\nSpecialist advice from this discussion (advice only; no agent started a task):\n${consultations.map(({ agent, advice }) => `### ${agent.name}\n${advice}`).join("\n\n")}`
        : advisors.length
          ? `\n\nSupervisor tried to consult ${advisors.map(agent => agent.name).join(", ")}, but none returned advice. Be transparent and answer from the conversation only.`
          : "";
      return this.model.chat([
        { role: "system", content: system + consultationContext },
        ...history,
        { role: "user", content: userContent }
      ], [], selection, options.onChunk, options.onThinking);
    };

    let response: ChatResponse;
    if (!options.supervisorDiscussion) {
      response = await finalReply(DISCUSSION_SYSTEM, []);
    } else {
      const supervisorSystem = `${DISCUSSION_SYSTEM} You are the Supervisor. Use specialist advice when available to help the client understand options and trade-offs, explain recommendations in plain language, state who you consulted, and ask only the next useful clarification. Do not request project details that can be found in the supplied conversation or attachments. Do not imply that you or the advisers inspected the workspace; distinguish advice from verified project findings.`;
      // A confident "no" from Laya skips the consult tool: small models sometimes call any tool they are offered.
      const skipConsult = decision?.consult && !decision.consult.value && decision.consult.mode !== "reason";
      if (askAll) {
        // The client asked for the whole team, so there is nothing to decide.
        response = await finalReply(supervisorSystem, agents);
      } else {
        // Think first, then decide: answer directly (streamed as it is written) or call consult_agents.
        const hint = selectDiscussionAdvisors(prompt, agents);
        const deciding = [
          supervisorSystem,
          "Before replying, decide whether specialist advice would materially improve your answer. If it would, call consult_agents with the 1-3 most relevant specialists and a focused question; otherwise reply directly.",
          `Available specialists: ${agents.map(agent => `${agent.id} (${agent.name}: ${agent.description})`).join("; ") || "none"}.`,
          hint.length ? `Keyword match suggests: ${hint.map(agent => agent.id).join(", ")}. Treat this as a hint, not an instruction.` : "",
          decision?.consult?.value && decision.consult.mode === "execute" ? "Laya, the team's decision model, is confident specialist advice would help here." : "",
          reasoningEffort === "high" ? "This request looks complex; reason carefully before deciding." : ""
        ].filter(Boolean).join("\n\n");
        const draft = agents.length && !skipConsult
          ? await this.model.chat([{ role: "system", content: deciding }, ...history, { role: "user", content: userContent }], [consultTool(agents)], selection, options.onChunk, options.onThinking)
          : await finalReply(supervisorSystem, []);
        const request = requestedConsultation(draft, agents);
        if (request) {
          if (draft.content) options.onStreamReset?.();
          response = await finalReply(supervisorSystem, request.advisors, request.question);
        } else {
          response = draft;
        }
      }
    }
    let answer = response.content?.trim();
    if (!answer && reasoningEffort !== "none") {
      // All output went to reasoning (or a stray tool call): answer once more, plainly, before giving up.
      options.onStreamReset?.();
      const retry = await this.model.chat([
        { role: "system", content: DISCUSSION_SYSTEM },
        ...history,
        { role: "user", content: userContent }
      ], [], { ...selection, reasoningEffort: "none" }, options.onChunk);
      answer = retry.content?.trim();
    }
    if (!answer) throw new Error("The model returned no discussion reply.");
    this.sessions.addDiscussionMessage(conversationId, options.agentId, "result", answer);
    return answer;
  }
}

/** The assignment includes bounded recent decisions, while the visible user message stays the final brief. */
export function assignmentInstruction(prompt: string, history: Array<{ role: "user" | "result"; text: string }>): string {
  const context = history.slice(-10).map(message => `${message.role === "user" ? "Client" : "Discussion assistant"}: ${message.text.slice(0, 900)}`).join("\n\n").slice(-6000);
  return context
    ? `Use the agreed client discussion as context for this task. The final assignment takes precedence.\n\nDiscussion:\n${context}\n\nFinal assignment:\n${prompt}`
    : prompt;
}
