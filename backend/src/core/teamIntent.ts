/**
 * Whether a request might need several agents, so routing asks Laya for a team plan.
 * The team questions add one yes/no per agent to the routing request, which makes it several times slower; a normal
 * single-topic request skips them. Cheap text signals only: when unsure this says no, and the lead can still delegate.
 */
const WORK_AREAS: RegExp[] = [
  /\b(implement|code|coding|fix|bug|refactor|function|endpoint|component|feature)\b/,
  /\b(tests?|testing|spec)\b/,
  /\b(docs?|document|documentation|readme|guide)\b/,
  /\b(deploy|deployment|pipeline|docker|ci|infrastructure|kubernetes)\b/,
  /\b(research|investigate|compare|evaluate)\b/,
  /\b(review|audit)\b/,
  /\b(plan|roadmap|architecture)\b/,
  /\b(database|schema|migration|sql)\b/
];

export function mayNeedTeam(message: string): boolean {
  const text = message.toLowerCase();
  if (text.length > 400) return true;
  // Two or more list items ("- …", "1. …") usually mean separate pieces of work.
  if ((message.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) ?? []).length >= 2) return true;
  if (WORK_AREAS.filter(area => area.test(text)).length >= 2) return true;
  return /\b(team|multiple agents|several agents|in parallel|end[- ]to[- ]end|full[- ]stack)\b/.test(text);
}

export interface TeamPlanTask { id: string; agent_id: string; instruction: string; depends_on: string[] }
export interface TeamPlan { objective: string; tasks: TeamPlanTask[] }

/** What each specialist would be asked to do, and the words in a request that call for it. */
const SPECIALISTS: Array<{ agentId: string; when: RegExp; instruction: string; changesWork: boolean }> = [
  {
    agentId: "researcher",
    when: /\b(research|investigate|compare|evaluate|why|explain|analy[sz]e|look into|root cause|how does|what does|fix|bug|error|exception|crash|broken|failing|fails?|regression)\b/,
    instruction: "Investigate the context: related code, recent changes and likely causes. Report findings with file paths and line numbers. Do not edit files.",
    changesWork: false
  },
  {
    agentId: "coder",
    when: /\b(implement|code|coding|fix|bug|refactor|function|endpoint|component|feature|error|exception|crash|broken|failing|fails?|tests?|testing)\b/,
    instruction: "Inspect the relevant code and make the change or fix, adding or updating tests where practical. Report the files you changed and why.",
    changesWork: true
  },
  {
    agentId: "devops",
    when: /\b(deploy|deployment|pipeline|docker|ci|cd|infrastructure|kubernetes|environment|env|server|config|configuration|migrations?|5\d\d)\b/,
    instruction: "Check the environment side: configuration, build, deployment and migrations that affect this request. Report what you found and anything that must change. Do not deploy.",
    changesWork: true
  },
  {
    agentId: "database",
    when: /\b(database|db|sql|schema|migrations?|query|queries)\b/,
    instruction: "Check the database side: the schema, migrations and queries involved. Report findings and any change the schema or queries need.",
    changesWork: true
  },
  {
    agentId: "documenter",
    when: /\b(docs?|document|documentation|readme|guide|changelog)\b/,
    instruction: "Write or update the documentation this request needs. Report the files you changed.",
    changesWork: true
  }
];

const REVIEW_INSTRUCTION = "Review the team's changes and findings for correctness, risks and missing tests. List what must change before this is done, or confirm it is ready.";

/**
 * A suggested team for the coordinator's prompt, after the design: the specialists the request calls for work in
 * parallel, and the reviewer checks their work. Only advice; the coordinator decides who it actually calls. Returns
 * undefined when one agent is enough: no specialist is called for, or a single one whose work needs no review.
 */
export function fallbackTeamPlan(message: string, agentIds: string[], coordinatorId: string): TeamPlan | undefined {
  const text = message.toLowerCase();
  const available = new Set(agentIds.filter(id => id !== coordinatorId));
  const picked = SPECIALISTS.filter(specialist => available.has(specialist.agentId) && specialist.when.test(text));
  const needsReview = picked.some(specialist => specialist.changesWork) && available.has("reviewer");
  if (!picked.length || (picked.length === 1 && !needsReview)) return undefined;
  const tasks: TeamPlanTask[] = picked.map(specialist => ({ id: specialist.agentId, agent_id: specialist.agentId, instruction: specialist.instruction, depends_on: [] }));
  if (needsReview) tasks.push({ id: "reviewer", agent_id: "reviewer", instruction: REVIEW_INSTRUCTION, depends_on: tasks.map(task => task.id) });
  return { objective: message.trim().slice(0, 6000), tasks };
}
