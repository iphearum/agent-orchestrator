import type { AgentDefinition, AgentMessage, ChatImageAttachment } from "./types";
import { OpenAICompatibleModel, type AgentModelSelection } from "./model";
import { SessionRepository } from "../storage/repositories/sessions";

export interface DiscussionOptions extends AgentModelSelection {
  agentId: string;
  supervisorDiscussion?: boolean;
  agents?: AgentDefinition[];
  attachments?: Array<{ name: string; content: string }>;
  images?: ChatImageAttachment[];
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
  onConsultation?: (agentId: string, advice?: string) => void;
}

const DISCUSSION_SYSTEM = [
  "You are helping a client define a task for an agent team.",
  "Discuss goals, constraints, acceptance criteria, and who may need to work on it.",
  "When consulted by the Supervisor, use specialist recommendations to help the client understand options and trade-offs.",
  "Ask focused questions when important details are missing. Summarize agreed decisions clearly.",
  "This is a discussion only. You have no tools and must not claim that agents started work, files changed, or a task was assigned.",
  "The client will explicitly choose Assign task when ready."
].join(" ");

const ALL_ADVISORS = /\b(?:ask|consult|include|hear from)?\s*(?:all|every|each|entire)\s+(?:available\s+)?(?:agents?|specialists?|team)\b|\b(?:agents?|specialists?|team)\s+(?:all|everyone)\b/i;
const STOP_WORDS = new Set("about after again also any are ask be before can check client could each for from give have help here how into just like me more most need not of our please should some that the their them then there these they this through want what when where which with would your".split(" "));
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
  if (ranked.length) return ranked.slice(0, 3).map(item => item.agent);

  // A broad request such as "review this project" still benefits from a research view and a quality check.
  const general = ["researcher", "reviewer"].map(id => available.find(agent => agent.id === id)).filter((agent): agent is AgentDefinition => !!agent);
  return (general.length ? general : available).slice(0, 2);
}

async function runConsultations(
  agents: AgentDefinition[],
  discussion: AgentMessage[],
  options: DiscussionOptions,
  model: OpenAICompatibleModel
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
        "You have no tools and have not inspected the workspace. Do not claim to have read files, changed anything, or started a task. State assumptions and ask at most one useful clarification."
      ].join(" ");
      try {
        const response = await model.chat([
          { role: "system", content: system },
          ...history,
          userMessage
        ], [], {
          providerId: agent.providerId ?? options.providerId,
          model: agent.model ?? options.model,
          reasoningEffort: options.reasoningEffort
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
    const advisors = options.supervisorDiscussion
      ? selectDiscussionAdvisors(prompt, options.agents ?? [])
      : [];
    const consultations = await runConsultations(advisors, messages, options, this.model);
    const consultationContext = consultations.length
      ? `\n\nSpecialist advice from this discussion (advice only; no agent started a task):\n${consultations.map(({ agent, advice }) => `### ${agent.name}\n${advice}`).join("\n\n")}`
      : advisors.length
        ? `\n\nSupervisor tried to consult ${advisors.map(agent => agent.name).join(", ")}, but none returned advice. Be transparent and answer from the conversation only.`
        : "";
    const supervisorSystem = options.supervisorDiscussion
      ? `${DISCUSSION_SYSTEM} You are the Supervisor. Use specialist advice when available, explain recommendations in plain language, state who you consulted, and ask only the next useful clarification. Do not request project details that can be found in the supplied conversation or attachments. Do not imply that you or the advisers inspected the workspace; distinguish advice from verified project findings.`
      : DISCUSSION_SYSTEM;
    const responseMessages: AgentMessage[] = [
      { role: "system", content: supervisorSystem + consultationContext },
      ...history,
      { role: "user", content: userContent }
    ];
    const response = await this.model.chat(responseMessages, [], {
      providerId: options.providerId, model: options.model, reasoningEffort: options.reasoningEffort
    }, options.onChunk, options.onThinking);
    const answer = response.content?.trim();
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
