from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "data/runtime.db"
    workspace_root: str = ".."
    allowed_origins: str = "null,http://127.0.0.1:3000,http://localhost:3000"
    laya_enabled: bool = True
    laya_model: str = "convaiinnovations/laya"
    laya_endpoint: str = ""
    laya_api_key: str = ""
    laya_timeout_ms: int = 10000
    laya_fallback_mode: str = "rules"
    automatic_execution_confidence: float = 0.90
    context_enrichment_confidence: float = 0.65
    model_base_url: str = "http://localhost:11434/v1"
    model_api_key: str = "local"
    model_name: str = "qwen3:8b"
    model_timeout_seconds: float = 120.0
    context_max_tokens: int = 12000
    context_recent_messages: int = 6
    max_tool_iterations: int = 4

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    @property
    def database_path(self) -> Path:
        path = Path(self.database_url)
        return path if path.is_absolute() else Path.cwd() / path

    @property
    def workspace_path(self) -> Path:
        path = Path(self.workspace_root)
        return path.resolve()

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
