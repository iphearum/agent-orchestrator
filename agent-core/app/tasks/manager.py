from typing import Any

from app.domain.ids import new_id
from app.storage.repositories import Repository, now


class TaskManager:
    """Owns task state transitions and publishes persisted task changes."""

    transitions = {
        "pending": {"planning", "active", "cancelled"},
        "planning": {"active", "blocked", "cancelled"},
        "active": {"blocked", "completed", "cancelled"},
        "blocked": {"active", "cancelled"},
        "completed": set(),
        "cancelled": set(),
    }

    def __init__(self, repository: Repository, hub):
        self.repository, self.hub = repository, hub

    async def create(self, **fields) -> dict[str, Any]:
        return await self.repository.create_task(**fields)

    async def update(self, task_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        current = await self.repository.task(task_id)
        if not current:
            return None
        next_status = changes.get("status")
        if next_status and next_status != current["status"]:
            if next_status not in self.transitions.get(current["status"], set()):
                raise ValueError(f"Task cannot move from {current['status']} to {next_status}.")
            if next_status == "completed":
                unfinished = await self.repository.db.one(
                    "SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND status NOT IN ('completed','cancelled')", (task_id,))
                if unfinished and unfinished["n"]:
                    raise ValueError("Task has unfinished child tasks.")
            changes = dict(changes)
            changes["started_at"] = current.get("started_at") or now() if next_status == "active" else current.get("started_at")
            changes["completed_at"] = now() if next_status == "completed" else None
        changes["updated_at"] = now()
        updated = await self.repository.update_task(task_id, changes)
        if next_status and next_status != current["status"] and updated:
            trace_id = new_id("TRACE")
            await self.repository.db.execute(
                "INSERT INTO trace_runs(id,conversation_id,task_id,status,ended_at,total_ms,metrics_json) VALUES(?,?,?,'completed',?,0,'{}')",
                (trace_id, current.get("conversation_id"), task_id, now()))
            event = await self.repository.trace_event(trace_id, 1, "task", agent_id=updated.get("agent_id"), task_id=task_id,
                label=f"Task status changed to {updated['status']}.", status=updated["status"], data={"status": updated["status"]})
            await self.hub.publish({**event, "kind": "task.updated"})
        return updated
