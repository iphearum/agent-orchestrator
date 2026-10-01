import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.domain.models import ChatRequest, ChatResponse, TaskStatusPatch, ToolApproval
from app.storage.sqlite import load_json

router = APIRouter()


def services(request: Request):
    return request.app.state.repository, request.app.state.hub


@router.get("/health")
async def health(request: Request):
    repo = request.app.state.repository
    row = await repo.db.one("SELECT 1 AS connected")
    counts = await repo.db.one("SELECT SUM(run_state IN ('running','thinking')) AS running FROM agents")
    tasks = await repo.db.one("SELECT COUNT(*) AS active FROM tasks WHERE status='active'")
    return {"status": "ok", "sqlite": "connected" if row else "disconnected", "laya": request.app.state.laya.status,
            "agents_running": int((counts or {}).get("running") or 0), "tasks_active": (tasks or {}).get("active", 0)}


@router.get("/workspaces")
async def workspaces(request: Request):
    repo, _ = services(request)
    return await repo.db.all("SELECT * FROM workspaces ORDER BY name")


@router.patch("/workspaces/{workspace_id}")
async def update_workspace(workspace_id: str, payload: dict[str, Any], request: Request):
    from pathlib import Path
    repo = request.app.state.repository
    row = await repo.db.one("SELECT * FROM workspaces WHERE id=?", (workspace_id,))
    if not row:
        raise HTTPException(404, "Workspace not found")
    candidate = Path(str(payload.get("root_path", ""))).expanduser().resolve()
    if not candidate.is_dir():
        raise HTTPException(400, "Workspace root must be an existing directory")
    name = str(payload.get("name") or candidate.name or "Workspace")[:120]
    await repo.db.execute("UPDATE workspaces SET root_path=?,name=? WHERE id=?", (str(candidate), name, workspace_id))
    request.app.state.registry.workspace_root = candidate
    return await repo.db.one("SELECT * FROM workspaces WHERE id=?", (workspace_id,))


@router.get("/agents")
async def agents(request: Request):
    repo, _ = services(request)
    return await repo.list_agents()


@router.get("/agents/{agent_id}")
async def agent(agent_id: str, request: Request):
    repo, _ = services(request)
    row = await repo.agent(agent_id)
    if not row:
        raise HTTPException(404, "Agent not found")
    row["tools"] = await repo.agent_tools(agent_id)
    return row


@router.get("/tools")
async def tools(request: Request):
    return await request.app.state.repository.list_tools()


@router.get("/tool-runs")
async def tool_runs(request: Request, status: str | None = None, limit: int = 100):
    rows = await request.app.state.repository.list_tool_runs(max(1, min(limit, 300)))
    return [row for row in rows if status is None or row["status"] == status]


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    try:
        result = await request.app.state.orchestrator.handle(payload)
        return ChatResponse(**result)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/conversations")
async def conversations(request: Request, limit: int = 20):
    return await request.app.state.repository.list_conversations(max(1, min(limit, 100)))


@router.post("/conversations")
async def create_conversation(request: Request):
    repo = request.app.state.repository
    rows = await repo.db.all("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
    conversation_id = await repo.get_or_create_conversation(None, rows[0]["id"] if rows else None, "New conversation")
    return await repo.conversation(conversation_id)


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: str, request: Request):
    row = await request.app.state.repository.conversation(conversation_id)
    if not row:
        raise HTTPException(404, "Conversation not found")
    return row


@router.get("/tasks")
async def tasks(request: Request, status: str | None = None, limit: int = 20):
    rows = await request.app.state.repository.list_tasks(max(1, min(limit, 100)))
    return [row for row in rows if status is None or row["status"] == status]


@router.post("/tasks")
async def create_task(payload: dict[str, Any], request: Request):
    try:
        return await request.app.state.task_manager.create(title=str(payload.get("title", "New task"))[:240],
            description=str(payload.get("description", ""))[:8000], workspace_id=payload.get("workspace_id"),
            agent_id=payload.get("agent_id"), conversation_id=payload.get("conversation_id"),
            priority=max(0, min(3, int(payload.get("priority", 0)))), task_type=str(payload.get("type", "feature"))[:40],
            tags=payload.get("tags", []))
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/tasks/{task_id}")
async def task(task_id: str, request: Request):
    row = await request.app.state.repository.task(task_id)
    if not row:
        raise HTTPException(404, "Task not found")
    return row


@router.patch("/tasks/{task_id}")
async def patch_task(task_id: str, payload: TaskStatusPatch, request: Request):
    try:
        row = await request.app.state.task_manager.update(task_id, payload.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not row:
        raise HTTPException(404, "Task not found")
    return row


@router.get("/tasks/{task_id}/flow")
async def task_flow(task_id: str, request: Request):
    repo = request.app.state.repository
    task = await repo.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    events = await repo.task_events(task_id)
    agent_ids = list(dict.fromkeys([event["agent_id"] for event in events if event.get("agent_id")] + [a["id"] for a in task["assignees"]]))
    agents = {item["id"]: item for item in await repo.list_agents()}
    nodes = [{"id": agent_id, "agent_id": agent_id, "name": agents.get(agent_id, {}).get("name", agent_id),
              "color": agents.get(agent_id, {}).get("color"), "status": agents.get(agent_id, {}).get("run_state", "idle"),
              "layer": index, "subtitle": "Task owner" if index == 0 else "Working on task"} for index, agent_id in enumerate(agent_ids)]
    edges = [{"source": agent_ids[index], "target": agent_ids[index + 1], "status": "succeeded"}
             for index in range(len(agent_ids) - 1)]
    return {"task_id": task_id, "nodes": nodes, "edges": edges, "events": events}


@router.get("/tasks/{task_id}/events")
async def task_events(task_id: str, request: Request, limit: int = 100):
    return await request.app.state.repository.task_events(task_id, max(1, min(limit, 500)))


@router.get("/tasks/{task_id}/tool-runs")
async def task_tool_runs(task_id: str, request: Request):
    task = await request.app.state.repository.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task["tool_runs"]


@router.get("/tasks/{task_id}/files")
async def task_files(task_id: str, request: Request):
    task = await request.app.state.repository.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task["files"]


@router.get("/tasks/{task_id}/tests")
async def task_tests(task_id: str, request: Request):
    task = await request.app.state.repository.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"passed": 0, "failed": 0, "duration_s": 0, "cases": []}


@router.get("/tasks/{task_id}/knowledge")
async def task_knowledge(task_id: str, request: Request):
    task = await request.app.state.repository.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task["knowledge"]


@router.get("/tasks/{task_id}/metrics")
async def task_metrics(task_id: str, request: Request):
    task = await request.app.state.repository.task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    events = task["tool_runs"]
    return {"tool_runs": len(events), "files_changed": len(task["files"]), "progress": task["plan"]["progress"] if task.get("plan") else 0}


@router.get("/plans")
async def plans(request: Request, task_id: str | None = None):
    sql = "SELECT * FROM plans" + (" WHERE task_id=?" if task_id else "") + " ORDER BY created_at DESC LIMIT 100"
    rows = await request.app.state.repository.db.all(sql, (task_id,) if task_id else ())
    for row in rows:
        row["steps"] = await request.app.state.repository.db.all("SELECT * FROM plan_steps WHERE plan_id=? ORDER BY position", (row["id"],))
    return rows


@router.get("/memory")
async def memory(request: Request, agent_id: str | None = None, limit: int = 50):
    sql = "SELECT * FROM memories" + (" WHERE agent_id=?" if agent_id else "") + " ORDER BY created_at DESC LIMIT ?"
    return await request.app.state.repository.db.all(sql, (agent_id, max(1, min(limit, 200))) if agent_id else (max(1, min(limit, 200)),))


@router.get("/knowledge")
async def knowledge(request: Request, query: str = "", limit: int = 50):
    if query:
        return await request.app.state.repository.retrieve_graph(query, max(1, min(limit, 100)))
    return await request.app.state.repository.db.all("""SELECT r.*,s.name AS source,t.name AS target FROM relations r
        JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id WHERE r.active=1 ORDER BY r.created_at DESC LIMIT ?""", (max(1, min(limit, 200)),))


@router.get("/debug/trace/{trace_id}")
async def trace(trace_id: str, request: Request):
    row = await request.app.state.repository.get_trace(trace_id)
    if not row:
        raise HTTPException(404, "Trace not found")
    return row


@router.post("/tool-runs/{run_id}/approve")
async def approve_tool(run_id: str, payload: ToolApproval, request: Request):
    result = await request.app.state.executor.approve(run_id, payload.approved_by, request.app.state.hub.publish)
    if not result:
        raise HTTPException(404, "Pending tool run not found")
    return result


@router.post("/tool-runs/{run_id}/reject")
async def reject_tool(run_id: str, request: Request):
    result = await request.app.state.executor.reject(run_id, request.app.state.hub.publish)
    if not result:
        raise HTTPException(404, "Pending tool run not found")
    return result


@router.get("/events/stream")
async def event_stream(request: Request, task_id: str | None = None):
    repo, hub = services(request)
    queue = hub.subscribe()
    last_id = request.headers.get("last-event-id")

    async def stream():
        seen: set[str] = set()
        try:
            if last_id:
                previous = await repo.db.one("SELECT rowid FROM trace_events WHERE id=?", (last_id,))
                if previous:
                    cursor = previous["rowid"]
                    while True:
                        history = await repo.db.all("SELECT rowid AS cursor_id,* FROM trace_events WHERE rowid>? ORDER BY rowid LIMIT 500", (cursor,))
                        if not history:
                            break
                        for row in history:
                            cursor = row.pop("cursor_id")
                            if task_id and row["task_id"] != task_id:
                                continue
                            row["data"] = load_json(row.pop("data_json"), {})
                            seen.add(row["id"])
                            yield f"id: {row['id']}\nevent: message\ndata: {json.dumps(row)}\n\n"
                        if len(history) < 500:
                            break
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if event.get("id") in seen:
                    continue
                seen.add(event.get("id"))
                if task_id and event.get("task_id") != task_id:
                    continue
                yield f"id: {event['id']}\nevent: message\ndata: {json.dumps(event)}\n\n"
        finally:
            hub.unsubscribe(queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
