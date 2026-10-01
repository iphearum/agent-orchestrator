import json
from datetime import datetime, timezone
from typing import Any

from app.domain.ids import new_id
from app.storage.sqlite import Database, load_json


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Repository:
    """Parameterized SQL persistence operations used by runtime services."""

    def __init__(self, db: Database):
        self.db = db

    async def get_or_create_conversation(self, conversation_id: str | None, workspace_id: str | None, message: str) -> str:
        if conversation_id:
            row = await self.db.one("SELECT id FROM conversations WHERE id=?", (conversation_id,))
            if not row:
                raise ValueError("Conversation was not found.")
            return conversation_id
        conversation_id = new_id("CONV")
        title = " ".join(message.strip().split())[:90] or "New conversation"
        await self.db.execute("INSERT INTO conversations(id,workspace_id,title) VALUES(?,?,?)", (conversation_id, workspace_id, title))
        return conversation_id

    async def save_message(self, conversation_id: str, role: str, content: str, agent_id: str | None = None) -> str:
        message_id = new_id("MSG")
        await self.db.execute(
            "INSERT INTO messages(id,conversation_id,agent_id,role,content,token_count) VALUES(?,?,?,?,?,?)",
            (message_id, conversation_id, agent_id, role, content, (len(content) + 3) // 4),
        )
        await self.db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now(), conversation_id))
        return message_id

    async def recent_messages(self, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        rows = await self.db.all(
            "SELECT role,content,agent_id,created_at FROM messages WHERE conversation_id=? AND active_context=1 ORDER BY created_at DESC,rowid DESC LIMIT ?",
            (conversation_id, limit),
        )
        return list(reversed(rows))

    async def list_agents(self, enabled_only: bool = False) -> list[dict[str, Any]]:
        where = "WHERE enabled=1 AND status='active'" if enabled_only else ""
        return await self.db.all(f"SELECT * FROM agents {where} ORDER BY sort_order,name")

    async def agent(self, agent_id: str) -> dict[str, Any] | None:
        return await self.db.one("SELECT * FROM agents WHERE id=?", (agent_id,))

    async def agent_tools(self, agent_id: str) -> list[dict[str, Any]]:
        return await self.db.all(
            """SELECT t.* FROM tools t JOIN agent_tools g ON g.tool_id=t.id
               WHERE g.agent_id=? AND t.enabled=1 ORDER BY g.priority DESC,t.name LIMIT 20""", (agent_id,)
        )

    async def list_tools(self) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT * FROM tools ORDER BY name")
        for row in rows:
            row["schema"] = load_json(row.pop("schema_json"), {})
        return rows

    async def create_trace(self, conversation_id: str, task_id: str | None, request_message_id: str) -> str:
        trace_id = new_id("TRACE")
        await self.db.execute(
            "INSERT INTO trace_runs(id,conversation_id,task_id,request_message_id,status) VALUES(?,?,?,'running')",
            (trace_id, conversation_id, task_id, request_message_id),
        )
        return trace_id

    async def trace_event(self, trace_id: str, seq: int, kind: str, *, agent_id: str | None = None,
                          task_id: str | None = None, label: str = "", status: str = "succeeded",
                          duration_ms: int | None = None, data: Any = None) -> dict[str, Any]:
        event = {"id": new_id("EV"), "trace_id": trace_id, "seq": seq, "kind": kind, "agent_id": agent_id,
                 "task_id": task_id, "label": label, "status": status, "duration_ms": duration_ms,
                 "data": data or {}, "created_at": now()}
        await self.db.execute(
            """INSERT INTO trace_events(id,trace_id,seq,kind,agent_id,task_id,label,status,duration_ms,data_json)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (event["id"], trace_id, seq, kind, agent_id, task_id, label, status, duration_ms, json.dumps(event["data"])),
        )
        return event

    async def next_trace_seq(self, trace_id: str) -> int:
        row = await self.db.one("SELECT COALESCE(MAX(seq),0)+1 AS n FROM trace_events WHERE trace_id=?", (trace_id,))
        return int(row["n"] if row else 1)

    async def finish_trace(self, trace_id: str, status: str, started: float, metrics: dict[str, Any]) -> None:
        import time
        await self.db.execute("UPDATE trace_runs SET status=?,ended_at=?,total_ms=?,metrics_json=? WHERE id=?",
                              (status, now(), int((time.monotonic() - started) * 1000), json.dumps(metrics), trace_id))

    async def get_trace(self, trace_id: str) -> dict[str, Any] | None:
        trace = await self.db.one("SELECT * FROM trace_runs WHERE id=?", (trace_id,))
        if not trace:
            return None
        trace["metrics"] = load_json(trace.pop("metrics_json"), {})
        trace["events"] = await self.db.all("SELECT * FROM trace_events WHERE trace_id=? ORDER BY seq", (trace_id,))
        for event in trace["events"]:
            event["data"] = load_json(event.pop("data_json"), {})
        return trace

    async def create_task(self, *, title: str, description: str = "", workspace_id: str | None = None,
                          agent_id: str | None = None, conversation_id: str | None = None,
                          priority: int = 0, task_type: str = "feature", tags: list[str] | None = None,
                          created_by: str = "user") -> dict[str, Any]:
        task_id = new_id("TASK")
        async with self.db.lock:
            assert self.db.connection
            try:
                await self.db.connection.execute("BEGIN IMMEDIATE")
                ws = workspace_id or (await (await self.db.connection.execute("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).fetchone())[0]
                row = await (await self.db.connection.execute("SELECT COALESCE(MAX(number),0)+1 AS n FROM tasks WHERE workspace_id=?", (ws,))).fetchone()
                number = row["n"]
                await self.db.connection.execute(
                    """INSERT INTO tasks(id,workspace_id,agent_id,conversation_id,number,title,description,status,priority,type,tags_json,created_by)
                       VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)""",
                    (task_id, ws, agent_id, conversation_id, number, title, description, priority, task_type, json.dumps(tags or []), created_by),
                )
                await self.db.connection.commit()
            except Exception:
                await self.db.connection.rollback()
                raise
        return await self.task(task_id) or {}

    async def list_tasks(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = await self.db.all("""SELECT t.*,a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id
                                  ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
                                  t.updated_at DESC LIMIT ?""", (limit,))
        for row in rows:
            row["tags"] = load_json(row.pop("tags_json", None), [])
        return rows

    async def task(self, task_id: str) -> dict[str, Any] | None:
        row = await self.db.one("SELECT t.*,a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?", (task_id,))
        if not row:
            return None
        row["tags"] = load_json(row.pop("tags_json", None), [])
        row["assignees"] = await self.db.all("""SELECT a.id,a.name,a.description,a.color,a.run_state,ta.activity
                                                FROM task_assignees ta JOIN agents a ON a.id=ta.agent_id WHERE ta.task_id=?""", (task_id,))
        if row["agent_id"] and not any(a["id"] == row["agent_id"] for a in row["assignees"]):
            agent = await self.agent(row["agent_id"])
            if agent:
                row["assignees"].append({**agent, "activity": "Task owner"})
        plans = await self.db.all("SELECT * FROM plans WHERE task_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", (task_id,))
        plan = plans[0] if plans else None
        if plan:
            plan["steps"] = await self.db.all("SELECT * FROM plan_steps WHERE plan_id=? ORDER BY position", (plan["id"],))
            countable = [s for s in plan["steps"] if s["status"] != "skipped"]
            plan["progress"] = (sum(s["status"] == "completed" for s in countable) / len(countable)) if countable else 0
        row["plan"] = plan
        row["files"] = await self.db.all("SELECT * FROM file_changes WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        row["tool_runs"] = await self.db.all("SELECT * FROM tool_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 30", (task_id,))
        row["knowledge"] = await self.db.all("""SELECT e.id,e.type,e.name,COUNT(r.id) AS relation_count
                                               FROM task_entities te JOIN entities e ON e.id=te.entity_id
                                               LEFT JOIN relations r ON (r.source_id=e.id OR r.target_id=e.id) AND r.active=1
                                               WHERE te.task_id=? GROUP BY e.id ORDER BY e.name""", (task_id,))
        return row

    async def update_task(self, task_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        current = await self.task(task_id)
        if not current:
            return None
        assignments = []
        values: list[Any] = []
        for key in ("title", "description", "priority", "status", "started_at", "completed_at", "updated_at"):
            if key in changes and changes[key] is not None:
                assignments.append(f"{key}=?")
                values.append(changes[key])
        if assignments:
            values.append(task_id)
            await self.db.execute(f"UPDATE tasks SET {','.join(assignments)} WHERE id=?", tuple(values))
        return await self.task(task_id)

    async def task_events(self, task_id: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT * FROM trace_events WHERE task_id=? ORDER BY created_at DESC,seq DESC LIMIT ?", (task_id, limit))
        for row in rows:
            row["data"] = load_json(row.pop("data_json"), {})
        return list(reversed(rows))

    async def list_conversations(self, limit: int = 20) -> list[dict[str, Any]]:
        return await self.db.all("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", (limit,))

    async def conversation(self, conversation_id: str) -> dict[str, Any] | None:
        row = await self.db.one("SELECT * FROM conversations WHERE id=?", (conversation_id,))
        if row:
            row["messages"] = await self.db.all("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", (conversation_id,))
        return row

    async def store_memory(self, agent_id: str, content: str, *, kind: str = "episodic", workspace_id: str | None = None,
                           conversation_id: str | None = None, source_message_id: str | None = None) -> str:
        memory_id = new_id("MEM")
        await self.db.execute(
            "INSERT INTO memories(id,agent_id,workspace_id,conversation_id,type,scope,content,source_message_id) VALUES(?,?,?,?,?,'agent',?,?)",
            (memory_id, agent_id, workspace_id, conversation_id, kind, content[:2000], source_message_id),
        )
        return memory_id

    async def retrieve_memories(self, agent_id: str, query: str, limit: int = 5, workspace_id: str | None = None) -> list[dict[str, Any]]:
        rows = await self.db.all("""SELECT * FROM memories WHERE active=1 AND (agent_id=? OR scope='global')
            AND (workspace_id IS NULL OR workspace_id=?) ORDER BY importance DESC,created_at DESC LIMIT 100""", (agent_id, workspace_id))
        terms = {w.casefold() for w in query.split() if len(w) > 2}
        scored = []
        for row in rows:
            body = row["content"].casefold()
            overlap = sum(term in body for term in terms)
            if overlap:
                row["score"] = overlap / max(1, len(terms)) + row["importance"] * 0.1
                scored.append(row)
        selected = sorted(scored, key=lambda item: item["score"], reverse=True)[:limit]
        for item in selected:
            await self.db.execute("UPDATE memories SET accessed_at=?,access_count=access_count+1 WHERE id=?", (now(), item["id"]))
        return selected

    async def upsert_relation(self, source_type: str, source_name: str, predicate: str, target_type: str, target_name: str,
                              source_message_id: str | None = None) -> dict[str, str]:
        source_display, target_display = source_name.strip(), target_name.strip()
        source_name = " ".join(source_name.casefold().strip().split()).rstrip(".,!?;:")
        target_name = " ".join(target_name.casefold().strip().split()).rstrip(".,!?;:")
        source_id, target_id = new_id("ENT"), new_id("ENT")
        source_data = json.dumps({"display_name": source_display, "aliases": []})
        target_data = json.dumps({"display_name": target_display, "aliases": []})
        single_value = {"uses_port", "database", "owned_by"}
        async with self.db.lock:
            assert self.db.connection
            try:
                await self.db.connection.execute("BEGIN IMMEDIATE")
                await self.db.connection.execute("INSERT OR IGNORE INTO entities(id,type,name,data_json) VALUES(?,?,?,?)", (source_id, source_type, source_name, source_data))
                await self.db.connection.execute("INSERT OR IGNORE INTO entities(id,type,name,data_json) VALUES(?,?,?,?)", (target_id, target_type, target_name, target_data))
                source = await (await self.db.connection.execute("SELECT id FROM entities WHERE type=? AND name=?", (source_type, source_name))).fetchone()
                target = await (await self.db.connection.execute("SELECT id FROM entities WHERE type=? AND name=?", (target_type, target_name))).fetchone()
                source_id, target_id = source["id"], target["id"]
                existing = await (await self.db.connection.execute("SELECT id FROM relations WHERE source_id=? AND predicate=? AND target_id=? AND active=1", (source_id, predicate, target_id))).fetchone()
                if existing:
                    relation_id = existing["id"]
                    await self.db.connection.execute("UPDATE relations SET confidence=MIN(1.0,confidence+0.05) WHERE id=?", (relation_id,))
                else:
                    if predicate in single_value:
                        await self.db.connection.execute("UPDATE relations SET active=0,valid_to=? WHERE source_id=? AND predicate=? AND active=1", (now(), source_id, predicate))
                    relation_id = new_id("REL")
                    await self.db.connection.execute("INSERT INTO relations(id,source_id,predicate,target_id,source_message_id,valid_from) VALUES(?,?,?,?,?,?)", (relation_id, source_id, predicate, target_id, source_message_id, now()))
                await self.db.connection.commit()
            except Exception:
                await self.db.connection.rollback()
                raise
        return {"source_id": source_id, "target_id": target_id, "relation_id": relation_id}

    async def retrieve_graph(self, query: str, limit: int = 12) -> list[dict[str, Any]]:
        terms = [w.casefold() for w in query.split() if len(w) > 2][:8]
        if not terms:
            return []
        clauses = " OR ".join("(s.name LIKE ? OR t.name LIKE ?)" for _ in terms)
        params = tuple(value for term in terms for value in (f"%{term}%", f"%{term}%"))
        return await self.db.all(
            f"""SELECT r.id,s.id AS source_id,s.name AS source,s.type AS source_type,r.predicate,t.id AS target_id,t.name AS target,t.type AS target_type,r.confidence
                FROM relations r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id
                WHERE r.active=1 AND {clauses} ORDER BY r.confidence DESC LIMIT ?""", (*params, limit)
        )

    async def pending_tool_runs(self) -> list[dict[str, Any]]:
        return await self.db.all("SELECT * FROM tool_runs WHERE status='pending_approval' ORDER BY created_at")

    async def tool_run(self, run_id: str) -> dict[str, Any] | None:
        row = await self.db.one("SELECT * FROM tool_runs WHERE id=?", (run_id,))
        if row:
            row["arguments"] = load_json(row.pop("arguments_json", None), {})
            row["result"] = load_json(row.pop("result_json", None), None)
        return row

    async def list_tool_runs(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = await self.db.all("SELECT * FROM tool_runs ORDER BY created_at DESC LIMIT ?", (limit,))
        for row in rows:
            row["arguments"] = load_json(row.pop("arguments_json", None), {})
            row["result"] = load_json(row.pop("result_json", None), None)
        return rows
