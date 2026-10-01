import re
import time
from typing import Any

from app.core.config import Settings
from app.decision.laya_runtime import LayaRuntime
from app.decision.policies import CODER_POLICY, GENERAL_POLICY, GLOBAL_POLICY


def confidence_of(answer: Any) -> float:
    if not isinstance(answer, dict):
        return 0.5
    value = answer.get("confidence", answer.get("probability", 0.5))
    try:
        return min(1.0, max(0.0, float(value)))
    except (ValueError, TypeError):
        return 0.5


def decision_mode(confidence: float, settings: Settings) -> str:
    if confidence >= settings.automatic_execution_confidence:
        return "execute"
    if confidence >= settings.context_enrichment_confidence:
        return "enrich"
    return "reason"


class AgentDecisionEngine:
    def __init__(self, runtime: LayaRuntime, settings: Settings):
        self.runtime = runtime
        self.settings = settings

    def _policy(self, profile: str) -> dict[str, Any]:
        return CODER_POLICY if profile == "coder" else GENERAL_POLICY

    def _questions(self, profile: str, state: dict[str, Any], agents: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        if profile == "global":
            policy = dict(GLOBAL_POLICY)
            candidates = agents
            if len(candidates) > 20:
                words = re.findall(r"[\w-]{3,}", state.get("message", "").casefold())
                ranked = sorted(candidates, key=lambda agent: (
                    -sum(word in " ".join((agent["id"], agent["name"], agent.get("description") or "")).casefold() for word in words),
                    agent["name"].casefold()))
                candidates = ranked[:20]
            policy["agent"] = {**policy["agent"], "criteria": {a["id"]: f"{a['name']}: {a.get('description') or ''}" for a in candidates}}
            return policy
        policy = dict(self._policy(profile))
        categories = sorted({t.get("category") for t in tools if t.get("category")})
        policy["tool"] = {**policy["tool"], "criteria": {
            **{category: f"Use granted {category.replace('_', ' ')} tools." for category in categories},
            "none": "No external tool is needed for this turn.",
        }}
        if "delegate" in policy:
            policy["delegate"] = {**policy["delegate"], "criteria": {"self": "Continue with this agent."}}
        return policy

    def _rules(self, profile: str, state: dict[str, Any], agents: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        text = state.get("message", "").casefold()
        granted = {tool["category"] for tool in tools}
        if profile == "global":
            requested = state.get("requested_agent")
            route = requested if any(agent["id"] == requested for agent in agents) else None
            if route is None:
                route = "coder" if re.search(r"\b(code|coding|bug|debug|implement|build|file|extension|project|fix|develop)\b", text) else "general"
            return {"agent": {"value": route, "confidence": 0.8}, "needs_deep_reasoning": {"value": True, "confidence": 0.8}}
        selected_tool = "none"
        if "workspace_write" in granted and re.search(r"\b(implement|build|develop|create|write|edit|change|fix|update|modify)\b", text):
            selected_tool = "workspace_write"
        elif "workspace_read" in granted and re.search(r"\b(search|find|look|inspect|read|files?|code|where|extension|project|repository)\b", text):
            selected_tool = "workspace_read"
        wants_memory = bool(re.search(r"\b(previous|before|remember|last time|history)\b", text))
        wants_graph = bool(re.search(r"\b(relation|connected|depends|uses|knowledge|entity)\b", text))
        return {
            "needs_memory": {"value": wants_memory, "confidence": 0.75},
            "needs_graph": {"value": wants_graph, "confidence": 0.7},
            "needs_vector": {"value": False, "confidence": 0.9},
            "tool": {"value": selected_tool, "confidence": 0.8},
            "needs_llm": {"value": True, "confidence": 0.99},
        }

    async def decide(self, profile: str, state: dict[str, Any], agents: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        questions = self._questions(profile, state, agents, tools)
        started = time.monotonic()
        try:
            result = await self.runtime.decide(state, questions)
            answers = self._normalize(result.get("answers", {}), questions)
            source, fallback_reason = "laya", None
        except Exception as exc:
            if self.settings.laya_fallback_mode == "none":
                answers = self._none(profile, state, agents, questions)
                source = "none"
            else:
                answers = self._rules(profile, state, agents, tools)
                source = "rules"
            fallback_reason = str(exc)
        latency_ms = int((time.monotonic() - started) * 1000)
        answer_data = {}
        for key, answer in answers.items():
            value, confidence = answer["value"], answer["confidence"]
            answer_data[key] = {"value": value, "confidence": confidence, "mode": decision_mode(confidence, self.settings)}
        return {"profile": profile, "answers": answer_data, "source": source, "fallback_reason": fallback_reason,
                "latency_ms": latency_ms, "routing": result.get("routing") if source == "laya" else None}

    def _normalize(self, raw: dict[str, Any], questions: dict[str, Any]) -> dict[str, dict[str, Any]]:
        normalized = {}
        for key, question in questions.items():
            answer = raw.get(key, {}) if isinstance(raw, dict) else {}
            value = answer.get("choice") if isinstance(answer, dict) else None
            criteria = question.get("criteria", {})
            valid = set(criteria)
            if question.get("type") == "choice":
                if key.startswith("needs_"):
                    value = str(value or "no").casefold() == "yes"
                elif value not in valid:
                    value = "none" if "none" in valid else ("general" if "general" in valid else next(iter(valid), None))
            normalized[key] = {"value": value, "confidence": confidence_of(answer)}
        return normalized

    def _none(self, profile: str, state: dict[str, Any], agents: list[dict[str, Any]], questions: dict[str, Any]) -> dict[str, dict[str, Any]]:
        values = {key: {"value": False, "confidence": 1.0} for key in questions}
        if "needs_llm" in values:
            values["needs_llm"]["value"] = True
        if profile == "global":
            requested = state.get("requested_agent")
            valid = {agent["id"] for agent in agents}
            values["agent"] = {"value": requested if requested in valid else "general", "confidence": 1.0}
        if "tool" in values:
            values["tool"]["value"] = "none"
        return values
