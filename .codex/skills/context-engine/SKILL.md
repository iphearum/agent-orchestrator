---
name: context-engine
description: Context builder, token budgeting, recent-message selection, conversation summaries, structured compression (summary/facts/decisions/open_tasks/entities/relationships routing) and tool:// result references/expansion for the VS Code agent runtime. Use this whenever you touch Orchestrator.fitContext/buildSystemPrompt, AgentDatabase.recentMessages/compressConversation, backend/src/core/context.ts or backend/src/memory/compression.ts, the agentOrchestrator.contextMaxTokens/contextRecentMessages settings, or change what goes into the main LLM prompt — even if the user just says "the prompt is too big" or "it forgot earlier messages".
---

# Context engine

The main LLM gets only useful context (spec §2.4). It never receives all history, all memory, all graph facts, all tools and all tool output. The context builder is where that promise is kept or broken.

## What exists

- `Orchestrator.fitContext(messages, memories, entities)` and `buildSystemPrompt(...)` assemble the prompt inline in the orchestrator.
- `AgentDatabase.recentMessages(conversationId, limit)` returns the latest summary + the last N `active_context=1` messages.
- `AgentDatabase.compressConversation(conversationId, keepRecent)` makes an **extractive** summary (no LLM) grouped into `user_requests / assistant_outcomes / events`, and flips `active_context=0`. It never deletes messages, which is correct. It is called after each root run.
- Settings: `agentOrchestrator.contextMaxTokens`, `contextRecentMessages` (default 6).

Move this into `backend/src/core/context.ts` (the builder) and `backend/src/memory/compression.ts`, with no `vscode` imports.

## Builder output

```ts
export interface BuiltContext {
  messages: ChatMessage[];          // provider-neutral
  tools: ToolSchema[];              // only the 1–3 selected (tool-engine)
  sections: Record<string, number>;// tokens per section → trace + Metrics tab
  refs: string[];                   // every memory://, entity://, tool:// included
  totalTokens: number;
  dropped: Record<string, number>;  // items cut per section
}
```

## Order and budget (spec §24)

| # | Section | Default | Source |
|---|---|---|---|
| 1 | system instructions | 1000 | global prompt |
| 2 | agent identity | 500 | `agents.system_prompt` + skills |
| 3 | current objective | (in task) | user message / task title |
| 4 | current task | 700 | compact task row |
| 5 | active plan | 500 | steps, current one marked |
| 6 | recent conversation | 3000 | latest summary + last N active messages |
| 7 | relevant memories | 1800 | `memory.retrieve` |
| 8 | relevant JEV facts | 700 | `jev.retrieve` triples |
| 9 | tool schemas | 1300 | selection (max 3) |
| 10 | reserved generation | 2500 | never filled |

- Scale the budgets from `contextMaxTokens` and clamp to the model's real window. The total must stay ≤ window − reserve.
- Leftover space flows to sections 6 and then 7. Never borrow from the reserve.
- Trim whole items, lowest score first, and record them in `dropped`. A section whose gate was false is omitted entirely, with no empty header.
- Keep the stable sections (1–2) first and byte-identical across turns. That maximises provider prompt-cache hits.
- Token estimate: one `estimateTokens(text)` helper (≈ chars / 4) behind an interface, so a provider-specific counter can replace it. Store `messages.token_count` at insert time.
- Emit a `context` trace event `{maxTokens, actualTokens, sections, dropped}`.

## Compression (spec §25–26)

Upgrade `compressConversation` from extractive to **structured**, keeping the current behaviour as the fallback when no LLM is available or the call fails:

1. Trigger in post-processing when the active tokens exceed ~70% of the recent-conversation budget, or the count of active messages exceeds a limit.
2. Take the oldest contiguous `active_context=1` run, excluding the last N messages.
3. Make one LLM call returning JSON `{summary, facts[], decisions[], open_tasks[], entities[], relationships[]}`. Validate it with a type guard; retry once, then fall back to the extractive summary.
4. In one transaction: insert into `summaries` (`summary` = prose, `structured_json` = the object; migration 002) → flip `active_context=0` on the covered messages. **Never delete messages** (spec §25, §39).
5. Route the parts (spec §26): `facts` → semantic memory · `decisions` → episodic (or procedural) memory · `open_tasks` → task manager (`pending`, deduped by title) · `entities`/`relationships` → the JEV upsert with conflict rules.
6. The next summary covers the previous summary + the new messages, so there is always exactly one latest summary. Old summaries remain rows.
7. Emit a `context` event `compressed {from, to, messages, tokensBefore, tokensAfter}`.

`recentMessages` already tolerates legacy summary formats (it parses JSON, falling back to raw text). Keep that tolerance when adding `structured_json`.

## Tool output and references (spec §30)

- History and context carry `tool://TR-…` + a summary of ≤ 300 chars, never raw output. The same applies to `memory://` and `entity://` when a section is cut down to IDs.
- `expand_ref` (a generalisation of the existing `expand_tool_result`) returns full content paged to fit the remaining budget. Trace every expansion. Frequent re-expansion of one ref means its summaries are too thin.

## Invariants to test

- Never over `min(contextMaxTokens, window) − reserve`.
- All gates false → the context holds only system + agent + task + recent messages.
- At most 3 tool schemas.
- The message count is unchanged by compression; only `active_context` flips.
- A 200-turn scripted conversation stays within budget on every turn (the phase 3 exit condition).
