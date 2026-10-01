import type { Answer, LayaHttpClient, Question } from "../../integrations/layaClient";
import { readChoice, readYesNo } from "../../integrations/layaClient";
import { decisionMode } from "../../core/decision";
import { estimateDiscussionEffort, type ReasoningEffort } from "../../core/reasoning";

/**
 * Laya policy for a discussion reply: how hard the message is (reasoning effort) and, for the Supervisor, whether
 * specialist advice would help. Two questions only; each one costs Laya a pass over the state.
 */
export function discussionQuestions(supervisor: boolean, effort = true): Record<string, Question> {
  return {
    ...(effort ? { effort: {
      type: "choice" as const,
      instructions: "How much reasoning does the assistant need before replying to the user's latest message?",
      criteria: {
        low: "Greeting, small talk, thanks, or a simple direct question.",
        medium: "Needs some thought: an explanation or a focused design question.",
        high: "Complex: multi-part, debugging, architecture, trade-offs, or code and error output."
      }
    } } : {}),
    ...(supervisor ? { consult: { type: "noul" as const, instructions: "Would advice from specialist agents (research, coding, database, review, planning) materially improve the reply?" } } : {})
  };
}

export interface DiscussionDecision {
  effort: { value: ReasoningEffort; confidence: number; source: "laya" | "rules" };
  /** Supervisor only, and only when Laya answered: whether specialist advice would help. */
  consult?: { value: boolean; confidence: number; mode: "execute" | "enrich" | "reason" };
  source: "laya" | "rules";
  /** Why the estimate was used instead of Laya; shown in the chat so a fallback is never silent. */
  fallbackReason?: string;
}

export interface DiscussionDecisionInput {
  prompt: string;
  supervisor: boolean;
  /** False when the client set the effort or turned thinking off, so Laya isn't asked about it. */
  effort?: boolean;
  attachments?: number;
  images?: number;
  recentContext?: string;
}

export interface DiscussionThresholds { automatic: number; enrichment: number; }

/** Ask Laya, gate each answer on its confidence, and fall back to the word-pattern estimate. */
export async function decideDiscussion(laya: LayaHttpClient | undefined, input: DiscussionDecisionInput, thresholds: DiscussionThresholds = { automatic: .9, enrichment: .65 }): Promise<DiscussionDecision> {
  const estimate = () => estimateDiscussionEffort(input.prompt, input);
  if (!laya) return { effort: { value: estimate(), confidence: 1, source: "rules" }, source: "rules", fallbackReason: "Laya is off." };
  let answers: Record<string, Answer>;
  try {
    answers = await laya.ask({
      agentId: input.supervisor ? "lead" : "discussion",
      agentName: input.supervisor ? "Supervisor" : "Discussion",
      message: input.prompt,
      availableTools: [],
      recentContextSummary: input.recentContext
    }, discussionQuestions(input.supervisor, input.effort !== false));
  } catch (error) {
    return { effort: { value: estimate(), confidence: 1, source: "rules" }, source: "rules", fallbackReason: error instanceof Error ? error.message : String(error) };
  }
  return readDiscussionAnswers(answers, input, thresholds);
}

/** Pure mapping, kept separate so the gating is easy to test. */
export function readDiscussionAnswers(answers: Record<string, Answer>, input: DiscussionDecisionInput, thresholds: DiscussionThresholds): DiscussionDecision {
  const efforts: ReasoningEffort[] = ["low", "medium", "high"];
  const effort = readChoice(answers.effort);
  const confident = effort && efforts.includes(effort.value as ReasoningEffort) && decisionMode(effort.confidence, thresholds.automatic, thresholds.enrichment) !== "reason";
  const consultAnswer = input.supervisor ? readYesNo(answers.consult) : undefined;
  const consult = consultAnswer ? { ...consultAnswer, mode: decisionMode(consultAnswer.confidence, thresholds.automatic, thresholds.enrichment) } : undefined;
  if (input.effort === false) return { effort: { value: estimateDiscussionEffort(input.prompt, input), confidence: 1, source: "rules" }, consult, source: "laya" };
  if (!confident) {
    return {
      effort: { value: estimateDiscussionEffort(input.prompt, input), confidence: 1, source: "rules" },
      consult,
      source: "rules",
      fallbackReason: effort ? `Laya was unsure about the effort (${Math.round(effort.confidence * 100)}%).` : "Laya gave no effort answer."
    };
  }
  return { effort: { value: effort.value as ReasoningEffort, confidence: effort.confidence, source: "laya" }, consult, source: "laya" };
}
