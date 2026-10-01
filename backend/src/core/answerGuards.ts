/**
 * Guards that keep an agent run ending in an answer for the client, not in an announcement of work it never did.
 * Small models often finish a turn with "Now let me create a summary:" and no tool call; accepting that as the
 * result leaves the client (or the agent that delegated) with nothing.
 */

/** "Let me…", "I'll…", "Now I…" — but not "Let me know…". */
const ANNOUNCEMENT = /\b(?:let me|let's|i(?:'ll| will| am going to|'m going to)|now i|next,? i|i'm now|i am now)\b(?!\s+know\b)/i;
const WORK_VERB = /\b(?:check|look|read|search|inspect|create|write|add|review|analy[sz]e|summari[sz]e|start|begin|examine|explore|investigate|gather|run|implement|update|fix|open|find|compile|draft|prepare|go through|dig|scan|list|collect|verify|test|build|outline)\w*/i;

/** True when the reply ends by announcing a next step instead of delivering it. */
export function looksUnfinished(text: string): boolean {
  const reply = text.trim();
  if (!reply) return false;
  const lastParagraph = reply.split(/\n\s*\n/).at(-1)!.trim();
  // "…what needs to be done next:" — a colon or ellipsis after an announcement promises content that never came.
  if (/(?::|\.\.\.|…)$/.test(lastParagraph) && ANNOUNCEMENT.test(lastParagraph)) return true;
  // A short reply that is only an announcement: "Now I'll add the new command to extension.ts."
  if (reply.length > 320) return false;
  const lastSentence = lastParagraph.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) ?? lastParagraph;
  return ANNOUNCEMENT.test(lastSentence) && WORK_VERB.test(lastSentence) && !/\?$/.test(lastSentence);
}

const ACTION_REQUEST = /^(?:please\s+|pls\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|go ahead and\s+|let's\s+)?(?:fix|implement|add|create|write|build|refactor|update|change|remove|delete|rename|make|carry out|do|run|deploy|apply|generate|install|migrate|edit|modify|set up|setup|configure|commit|move|replace|start|continue|proceed)\b/i;
const QUESTION_START = /^(?:what|why|how|which|who|where|when|is|are|was|were|does|do|did|any|should|explain|describe|summari[sz]e|tell me|show me|give me|list|compare|recommend|review|check)\b/i;

/**
 * True when the client asked a question (for an explanation, description, plan or recommendation) rather than for
 * a change. Agents then answer it and leave the workspace alone. Imperatives such as "Can you fix…?" are requests.
 */
export function isAnswerOnlyRequest(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || ACTION_REQUEST.test(text)) return false;
  return /\?\s*$/.test(text) || QUESTION_START.test(text);
}

/**
 * Tracks which lines of each file an agent has read in a task. Small models "scroll" by re-reading a window shifted by
 * one line, which fills the context with near-identical text; a read that is mostly already seen gets a pointer instead.
 */
export class ReadCoverage {
  private readonly seen = new Map<string, Array<[number, number]>>();

  /** Returns a note to send instead of the result when at least 80% of the lines were already read, else records them. */
  check(result: string): string | undefined {
    const match = result.match(/^(.+?) · lines (\d+)-(\d+) of (\d+)/);
    if (!match) return undefined;
    const [, path, from, to, total] = match;
    const start = Number(from), end = Number(to);
    const ranges = this.seen.get(path) ?? [];
    let covered = 0;
    for (let line = start; line <= end; line++) if (ranges.some(([a, b]) => line >= a && line <= b)) covered++;
    if (ranges.length && covered >= .8 * (end - start + 1)) {
      const furthest = Math.max(...ranges.map(([, b]) => b));
      const next = furthest < Number(total) ? ` The next unread part starts at line ${furthest + 1}.` : " You have read to the end of the file.";
      return JSON.stringify({ note: `You already read most of ${path} lines ${start}-${end} earlier in this task; that text is above in the conversation.${next} Use what you have, read a different range, or answer now.` });
    }
    ranges.push([start, end]);
    this.seen.set(path, ranges);
    return undefined;
  }
}
