import type { ProviderReasoningEffort } from "./model";

export type ReasoningEffort = "low" | "medium" | "high";
export type ThinkingMode = "auto" | "on" | "off";

const HARD_TERMS = /\b(?:why|architect\w*|design|trade-?offs?|compare|comparison|debug\w*|root cause|migrat\w*|refactor\w*|security|performance|scal\w*|strategy|concurren\w*|race condition|optimi[sz]\w*|algorithm|edge cases?|requirements?|integrat\w*)\b/gi;

/** Estimate how much reasoning a message needs from its length, code, attachments and the kind of question. */
export function estimateDiscussionEffort(prompt: string, extras: { attachments?: number; images?: number } = {}): ReasoningEffort {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (words > 60) score++;
  if (words > 200) score++;
  if (/```|\bat [\w.$<>]+ \(|\b\w*(?:Error|Exception)\b:/.test(prompt)) score += 2;
  if ((extras.attachments ?? 0) + (extras.images ?? 0) > 0) score++;
  score += Math.min(3, new Set((prompt.match(HARD_TERMS) ?? []).map(term => term.toLowerCase())).size);
  if ((prompt.match(/\?/g) ?? []).length >= 2) score++;
  return score >= 3 ? "high" : score >= 1 ? "medium" : "low";
}

export interface ResolvedReasoning {
  /** Whether the agent should be asked to reason before answering. */
  thinking: boolean;
  /** Sent to the provider. "none" turns a thinking model's reasoning off; providers that reject the field are retried without it. */
  reasoningEffort?: ProviderReasoningEffort;
  /** Set when the effort was chosen from the estimate rather than by the client, so the UI can say so. */
  estimated?: ReasoningEffort;
}

/**
 * Combine the Thinking mode and the effort slider. A manual effort always wins for the provider field;
 * Auto thinks only when the estimate is medium or high, On thinks at least at medium, Off and an easy Auto turn reasoning off.
 */
export function resolveReasoning(prompt: string, options: { thinking?: ThinkingMode; reasoningEffort?: ProviderReasoningEffort; attachments?: number; images?: number; /** A decision from Laya (or its fallback) replaces the word-pattern estimate. */ estimate?: ReasoningEffort }): ResolvedReasoning {
  const mode = options.thinking ?? "auto";
  const manual = options.reasoningEffort;
  if (mode === "off" || manual === "none") return { thinking: false, reasoningEffort: manual ?? "none" };
  if (manual) return { thinking: mode === "on" || manual !== "low", reasoningEffort: manual };
  const estimate = options.estimate ?? estimateDiscussionEffort(prompt, options);
  if (mode === "on") {
    const effort = estimate === "low" ? "medium" : estimate;
    return { thinking: true, reasoningEffort: effort, estimated: effort };
  }
  return estimate === "low" ? { thinking: false, reasoningEffort: "none" } : { thinking: true, reasoningEffort: estimate, estimated: estimate };
}
