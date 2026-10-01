from typing import Any, Literal

from pydantic import BaseModel, Field


class Agent(BaseModel):
    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str | None = None
    laya_profile: str
    status: str = "active"
    enabled: bool = True
    color: str | None = None
    run_state: str = "idle"


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    task_id: str | None = None
    workspace_id: str | None = None
    agent_id: str | None = None
    message: str = Field(min_length=1, max_length=30000)


class ChatResponse(BaseModel):
    message: str
    conversation_id: str
    agent: str
    tools_used: list[str] = []
    memory_used: list[str] = []
    graph_used: list[str] = []
    trace_id: str
    task_id: str | None = None
    pending_approvals: list[str] = []


class TaskStatusPatch(BaseModel):
    status: Literal["pending", "planning", "active", "blocked", "completed", "cancelled"] | None = None
    title: str | None = None
    description: str | None = None
    priority: int | None = None


class ToolApproval(BaseModel):
    approved_by: str = "user"
