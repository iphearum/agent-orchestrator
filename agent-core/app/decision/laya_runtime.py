import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from typing import Any

import httpx

from app.core.config import Settings


class LayaRuntime:
    """One shared HTTP connection and circuit breaker for the Laya decision service."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.AsyncClient(timeout=max(0.1, min(60, settings.laya_timeout_ms / 1000)))
        self.unavailable_until = 0.0
        self.last_error: str | None = None
        self.last_success_at: str | None = None

    @property
    def status(self) -> dict[str, Any]:
        if self.last_error:
            state = "fallback"
        elif self.last_success_at:
            state = "online"
        else:
            state = "offline"
        return {"status": state, "enabled": self.settings.laya_enabled,
                "last_error": self.last_error, "last_success_at": self.last_success_at}

    async def decide(self, state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any]:
        endpoint = self.settings.laya_endpoint.strip()
        if not self.settings.laya_enabled:
            raise RuntimeError("Laya is disabled")
        if not endpoint:
            self.last_error = "LAYA_ENDPOINT is not configured"
            raise RuntimeError(self.last_error)
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}):
            self.last_error = "Laya endpoints must use HTTPS (HTTP is allowed on loopback)"
            raise RuntimeError(self.last_error)
        if time.monotonic() < self.unavailable_until:
            raise RuntimeError(self.last_error or "Laya circuit is open")
        compact = {
            **{key: value for key, value in state.items() if key not in {"message", "recent_context", "entities", "agents"}},
            "message": str(state.get("message", ""))[:6000],
            "recent_context": str(state.get("recent_context", ""))[-3000:],
            "available_tools": list(state.get("available_tools", []))[:20],
            "entities": list(state.get("entities", []))[:20],
            "agents": list(state.get("agents", []))[:30],
        }
        headers = {"content-type": "application/json"}
        if self.settings.laya_api_key:
            headers["authorization"] = f"Bearer {self.settings.laya_api_key}"
        try:
            response = await self.client.post(endpoint, json={"state": compact, "questions": questions}, headers=headers)
            response.raise_for_status()
            result = response.json()
            if not isinstance(result.get("answers"), dict):
                raise RuntimeError("Laya response is missing typed answers")
            self.last_error = None
            self.unavailable_until = 0
            self.last_success_at = datetime.now(timezone.utc).isoformat()
            return result
        except Exception as exc:
            self.last_error = str(exc)[:500]
            self.unavailable_until = time.monotonic() + 30
            raise RuntimeError(self.last_error) from exc

    async def close(self) -> None:
        await self.client.aclose()
