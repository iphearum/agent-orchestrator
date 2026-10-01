import asyncio
import json
import time
from typing import Any

from app.domain.ids import format_ref, new_id
from app.storage.repositories import Repository
from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry


class ToolExecutor:
    def __init__(self, registry: ToolRegistry, repository: Repository, task_manager=None):
        self.registry, self.repository, self.task_manager = registry, repository, task_manager

    async def execute(self, *, name: str, arguments: dict[str, Any], granted_names: set[str], context: ToolContext,
                      decision_mode: str, publish, seq: int) -> dict[str, Any]:
        tool = self.registry.get(name)
        if not tool or name not in granted_names:
            run_id = new_id("TR")
            summary = "Tool is unavailable or not granted to this agent."
            await self.repository.db.execute(
                "INSERT INTO tool_runs(id,conversation_id,task_id,agent_id,tool_name,arguments_json,summary,status,trace_id,risk_level) VALUES(?,?,?,?,?,?,?,'rejected',?,?)",
                (run_id, context.conversation_id, context.task_id, context.agent_id, name, json.dumps(arguments), summary, context.trace_id, tool.risk_level if tool else 0),
            )
            event = await self.repository.trace_event(context.trace_id, seq, "tool", agent_id=context.agent_id, task_id=context.task_id,
                label=summary, status="rejected", data={"tool": name, "ref": format_ref("tool", run_id)})
            await publish(event)
            return {"run_id": run_id, "summary": summary, "status": "rejected",
                    "content": f"{format_ref('tool', run_id)}\nsummary: {summary}", "pending": False, "event": event}

        try:
            parsed = tool.args_model.model_validate(arguments)
        except Exception as exc:
            return await self._failed(tool, arguments, context, publish, seq, f"Invalid arguments: {exc}")

        requires_approval = tool.requires_approval or tool.risk_level >= 2 or (tool.risk_level == 1 and decision_mode != "execute")
        run_id = new_id("TR")
        started = time.monotonic()
        if requires_approval:
            summary = f"Approval required to {tool.display_name.lower()}."
            await self.repository.db.execute(
                "INSERT INTO tool_runs(id,conversation_id,task_id,agent_id,tool_name,arguments_json,summary,status,trace_id,risk_level) VALUES(?,?,?,?,?,?,?,'pending_approval',?,?)",
                (run_id, context.conversation_id, context.task_id, context.agent_id, name, json.dumps(parsed.model_dump()), summary, context.trace_id, tool.risk_level),
            )
            await self.repository.db.execute("UPDATE agents SET run_state='waiting' WHERE id=?", (context.agent_id,))
            event = await self.repository.trace_event(context.trace_id, seq, "approval", agent_id=context.agent_id, task_id=context.task_id,
                label=summary, status="pending_approval", data={"tool": name, "tool_run_id": run_id, "arguments": parsed.model_dump()})
            await publish(event)
            return {"run_id": run_id, "summary": summary, "status": "pending_approval",
                    "content": f"{format_ref('tool', run_id)}\nsummary: {summary}", "pending": True, "event": event}

        await self.repository.db.execute(
            "INSERT INTO tool_runs(id,conversation_id,task_id,agent_id,tool_name,arguments_json,status,trace_id,risk_level) VALUES(?,?,?,?,?,?,'running',?,?)",
            (run_id, context.conversation_id, context.task_id, context.agent_id, name, json.dumps(parsed.model_dump()), context.trace_id, tool.risk_level),
        )
        await self.repository.db.execute("UPDATE agents SET run_state='running' WHERE id=?", (context.agent_id,))
        status, error = "succeeded", None
        try:
            result = await asyncio.wait_for(tool.execute(parsed, context), timeout=30)
            result_data = result.model_dump()
        except Exception as exc:
            status, error = "failed", str(exc)[:1000]
            result_data = {"ok": False, "data": None, "summary": error, "file_changes": []}
        duration = int((time.monotonic() - started) * 1000)
        summary = result_data["summary"]
        await self.repository.db.execute("UPDATE tool_runs SET result_json=?,summary=?,status=?,duration_ms=? WHERE id=?",
            (json.dumps(result_data), summary, status, duration, run_id))
        for change in result_data.get("file_changes", []):
            await self.repository.db.execute(
                "INSERT INTO file_changes(id,task_id,tool_run_id,path,additions,deletions,before_text,diff_text) VALUES(?,?,?,?,?,?,?,?)",
                (new_id("FC"), context.task_id, run_id, change["path"], change["additions"], change["deletions"], change["before_text"], change["diff_text"]),
            )
        label = summary if status == "succeeded" else f"{tool.display_name} failed: {summary}"
        event = await self.repository.trace_event(context.trace_id, seq, "tool", agent_id=context.agent_id, task_id=context.task_id,
            label=label, status=status, duration_ms=duration, data={"tool": name, "category": tool.category,
            "ref": format_ref("tool", run_id), "summary": summary})
        await publish(event)
        ref = format_ref("tool", run_id)
        content = (str((result_data.get("data") or {}).get("content", "")) if name == "expand_ref"
                   else f"{ref}\nsummary: {summary}")
        return {"run_id": run_id, "summary": summary, "status": status,
                "content": content, "pending": False, "event": event, "error": error}

    async def approve(self, run_id: str, approved_by: str, publish) -> dict[str, Any] | None:
        row = await self.repository.tool_run(run_id)
        if not row or row["status"] != "pending_approval":
            return None
        tool = self.registry.get(row["tool_name"])
        if not tool:
            return None
        changed = await self.repository.db.execute("UPDATE tool_runs SET status='running' WHERE id=? AND status='pending_approval'", (run_id,))
        if not changed:
            return None
        conversation = await self.repository.db.one("SELECT workspace_id FROM conversations WHERE id=?", (row["conversation_id"],))
        context = ToolContext(agent_id=row["agent_id"], conversation_id=row["conversation_id"], task_id=row["task_id"],
            trace_id=row["trace_id"], workspace_root=self.registry.workspace_root,
            workspace_id=conversation.get("workspace_id") if conversation else None)
        started = time.monotonic()
        status, result_data = "succeeded", None
        try:
            result = await asyncio.wait_for(self.registry.invoke(tool.name, row["arguments"], context), timeout=30)
            result_data = result.model_dump()
        except Exception as exc:
            status, result_data = "failed", {"ok": False, "summary": str(exc)[:1000], "data": None, "file_changes": []}
        duration = int((time.monotonic() - started) * 1000)
        summary = result_data["summary"]
        await self.repository.db.execute("UPDATE tool_runs SET result_json=?,summary=?,status=?,approved_by=?,duration_ms=? WHERE id=?",
            (json.dumps(result_data), summary, status, approved_by, duration, run_id))
        for change in result_data.get("file_changes", []):
            await self.repository.db.execute(
                "INSERT INTO file_changes(id,task_id,tool_run_id,path,additions,deletions,before_text,diff_text) VALUES(?,?,?,?,?,?,?,?)",
                (new_id("FC"), context.task_id, run_id, change["path"], change["additions"], change["deletions"], change["before_text"], change["diff_text"]),
            )
        seq = await self.repository.next_trace_seq(row["trace_id"])
        event = await self.repository.trace_event(row["trace_id"], seq, "approval", agent_id=context.agent_id,
            task_id=context.task_id, label=f"Approved and completed {tool.display_name.lower()}.", status=status,
            duration_ms=duration, data={"tool": tool.name, "tool_run_id": run_id, "approved_by": approved_by})
        await publish(event)
        await self.repository.db.execute("UPDATE agents SET run_state='idle' WHERE id=?", (context.agent_id,))
        pending = await self.repository.db.one("SELECT COUNT(*) AS n FROM tool_runs WHERE trace_id=? AND status='pending_approval'", (row["trace_id"],))
        if pending and not pending["n"]:
            await self.repository.db.execute("UPDATE trace_runs SET status='completed',ended_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting'", (row["trace_id"],))
            if row.get("task_id") and self.task_manager:
                task = await self.repository.task(row["task_id"])
                if task and task["status"] == "blocked":
                    await self.task_manager.update(row["task_id"], {"status": "active"})
        return {"id": run_id, "status": status, "summary": summary}

    async def reject(self, run_id: str, publish) -> dict[str, Any] | None:
        row = await self.repository.tool_run(run_id)
        if not row or row["status"] != "pending_approval":
            return None
        changed = await self.repository.db.execute("UPDATE tool_runs SET status='rejected',summary='Approval was rejected.' WHERE id=? AND status='pending_approval'", (run_id,))
        if not changed:
            return None
        seq = await self.repository.next_trace_seq(row["trace_id"])
        event = await self.repository.trace_event(row["trace_id"], seq, "approval", agent_id=row["agent_id"], task_id=row["task_id"],
            label="Tool approval was rejected.", status="rejected", data={"tool_run_id": run_id})
        await publish(event)
        await self.repository.db.execute("UPDATE agents SET run_state='idle' WHERE id=?", (row["agent_id"],))
        pending = await self.repository.db.one("SELECT COUNT(*) AS n FROM tool_runs WHERE trace_id=? AND status='pending_approval'", (row["trace_id"],))
        if pending and not pending["n"]:
            await self.repository.db.execute("UPDATE trace_runs SET status='completed',ended_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting'", (row["trace_id"],))
            if row.get("task_id") and self.task_manager:
                task = await self.repository.task(row["task_id"])
                if task and task["status"] == "blocked":
                    await self.task_manager.update(row["task_id"], {"status": "active"})
        return {"id": run_id, "status": "rejected"}

    async def _failed(self, tool, arguments, context, publish, seq, error: str) -> dict[str, Any]:
        run_id = new_id("TR")
        await self.repository.db.execute(
            "INSERT INTO tool_runs(id,conversation_id,task_id,agent_id,tool_name,arguments_json,result_json,summary,status,trace_id,risk_level) VALUES(?,?,?,?,?,?,?,?,'failed',?,?)",
            (run_id, context.conversation_id, context.task_id, context.agent_id, tool.name, json.dumps(arguments), json.dumps({"error": error}), error, context.trace_id, tool.risk_level),
        )
        event = await self.repository.trace_event(context.trace_id, seq, "tool", agent_id=context.agent_id, task_id=context.task_id,
            label=f"{tool.display_name} failed: {error}", status="failed", data={"tool": tool.name, "error": error})
        await publish(event)
        return {"run_id": run_id, "summary": error, "status": "failed",
                "content": f"{format_ref('tool', run_id)}\nsummary: {error}", "pending": False, "event": event}
