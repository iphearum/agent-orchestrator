import json
import math
from typing import Any

from app.core.config import Settings


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


class ContextBuilder:
    def __init__(self, settings: Settings):
        self.settings = settings

    def build(self, *, system_prompt: str, objective: str, messages: list[dict[str, Any]], task: dict[str, Any] | None,
              plan: dict[str, Any] | None, memories: list[dict[str, Any]], graph: list[dict[str, Any]],
              tool_schemas: list[dict[str, Any]]) -> tuple[list[dict[str, str]], dict[str, Any]]:
        sections: list[tuple[str, str]] = [("system", system_prompt), ("objective", objective)]
        if task:
            sections.append(("task", json.dumps({k: task.get(k) for k in ("number", "title", "description", "status")}, ensure_ascii=False)))
        if plan:
            sections.append(("plan", json.dumps({"objective": plan.get("objective"), "steps": plan.get("steps", [])}, ensure_ascii=False)))
        if memories:
            sections.append(("memories", "Relevant memories:\n" + "\n".join(f"- memory://{m['id']} {m['content'][:300]}" for m in memories)))
        if graph:
            sections.append(("knowledge", "Relevant project facts:\n" + "\n".join(f"- entity://{r['source_id']} {r['source']} → {r['predicate']} → {r['target']} (entity://{r['target_id']})" for r in graph)))
        if tool_schemas:
            sections.append(("tools", "Only these tools are available this turn:\n" + json.dumps([s["function"] for s in tool_schemas], ensure_ascii=False)))
        reserve = min(2500, max(256, self.settings.context_max_tokens // 4))
        budget = max(256, self.settings.context_max_tokens - reserve)
        caps = {"system": 1500, "objective": 3000, "task": 700, "plan": 500,
                "memories": 1800, "knowledge": 700, "tools": 1300}
        cap_total = sum(caps.values())
        scale = min(1.0, budget / cap_total)
        sections = [(name, self._clip(body, max(1, int(caps.get(name, budget) * scale)))) for name, body in sections]
        used = sum(estimate_tokens(body) for _, body in sections)
        dropped = []
        # Preserve recent history; drop oldest complete turns as a unit until it fits.
        kept = messages[-max(1, self.settings.context_recent_messages):]
        while kept and used + sum(estimate_tokens(m["content"]) for m in kept) > budget:
            removed = kept.pop(0)
            dropped.append({"section": "conversation", "reason": "budget", "tokens": estimate_tokens(removed["content"])})
        output = [{"role": "system", "content": "\n\n".join(f"[{name}]\n{body}" for name, body in sections)}]
        output.extend({"role": "assistant" if m["role"] == "tool" else m["role"],
                       "content": f"Tool result reference: {m['content']}" if m["role"] == "tool" else m["content"]}
                      for m in kept)
        actual = sum(estimate_tokens(m["content"]) for m in output)
        while actual > budget and len(sections) > 2:
            name, body = sections.pop(-2 if len(sections) > 2 else -1)
            dropped.append({"section": name, "reason": "budget", "tokens": estimate_tokens(body)})
            output[0]["content"] = "\n\n".join(f"[{label}]\n{text}" for label, text in sections)
            actual = sum(estimate_tokens(m["content"]) for m in output)
        return output, {"max_tokens": budget, "actual_tokens": actual, "sections": [name for name, _ in sections], "dropped": dropped}

    @staticmethod
    def _clip(text: str, max_tokens: int) -> str:
        limit = max_tokens * 4
        if len(text) <= limit:
            return text
        cut = text[:max(0, limit - 24)]
        boundary = max(cut.rfind(". "), cut.rfind("\n"), cut.rfind(" "))
        if boundary > limit // 2:
            cut = cut[:boundary]
        return cut.rstrip() + " …[section trimmed]"
