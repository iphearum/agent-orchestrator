from pathlib import Path
from typing import Any

from pydantic import BaseModel


class ToolResult(BaseModel):
    ok: bool
    data: Any = None
    summary: str
    file_changes: list[dict[str, Any]] = []


class ToolContext(BaseModel):
    agent_id: str
    conversation_id: str
    task_id: str | None = None
    workspace_id: str | None = None
    trace_id: str
    workspace_root: Path

    class Config:
        arbitrary_types_allowed = True


class Tool:
    name: str
    description: str
    category: str
    display_name: str
    args_model: type[BaseModel]
    risk_level: int = 0
    requires_approval: bool = False

    async def execute(self, args: BaseModel, ctx: ToolContext) -> ToolResult:
        raise NotImplementedError

    def schema(self) -> dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description,
                "parameters": self.args_model.model_json_schema()}}
