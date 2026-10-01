from typing import Any

import httpx

from app.core.config import Settings


class OpenAICompatibleModel:
    """Chat Completions adapter for Ollama and OpenAI-compatible servers."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.AsyncClient(timeout=settings.model_timeout_seconds)

    async def generate(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str | None = None) -> dict[str, Any]:
        base = self.settings.model_base_url.rstrip("/")
        headers = {"authorization": f"Bearer {self.settings.model_api_key}"} if self.settings.model_api_key else {}
        payload: dict[str, Any] = {"model": model or self.settings.model_name, "messages": messages, "temperature": 0.2}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        response = await self.client.post(f"{base}/chat/completions", json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
        choice = (data.get("choices") or [{}])[0].get("message") or {}
        return {"content": choice.get("content") or "", "tool_calls": choice.get("tool_calls") or [],
                "usage": data.get("usage") or {}, "model": data.get("model", model or self.settings.model_name)}

    async def close(self) -> None:
        await self.client.aclose()
