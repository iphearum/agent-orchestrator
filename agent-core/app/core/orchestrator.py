import json
import re
import time
from typing import Any

from app.core.config import Settings
from app.core.context import ContextBuilder
from app.core.events import EventHub
from app.decision.engine import AgentDecisionEngine
from app.decision.result import should_invoke_llm, should_retrieve
from app.domain.ids import new_id
from app.models.openai_compatible import OpenAICompatibleModel
from app.storage.repositories import Repository, now
from app.tools.base import ToolContext
from app.tools.executor import ToolExecutor
from app.tools.registry import ToolRegistry


class Orchestrator:
    def __init__(self, settings: Settings, repository: Repository, decision: AgentDecisionEngine,
                 registry: ToolRegistry, executor: ToolExecutor, model: OpenAICompatibleModel,
                 hub: EventHub, task_manager):
        self.settings, self.repository, self.decision = settings, repository, decision
        self.registry, self.executor, self.model, self.hub = registry, executor, model, hub
        self.task_manager = task_manager
        self.context_builder = ContextBuilder(settings)

    async def handle(self, request) -> dict[str, Any]:
        message = " ".join(request.message.strip().split())
        if not message:
            raise ValueError("Message cannot be blank.")
        conversation_id = await self.repository.get_or_create_conversation(request.conversation_id, request.workspace_id, message)
        user_message_id = await self.repository.save_message(conversation_id, "user", message)
        trace_id = await self.repository.create_trace(conversation_id, request.task_id, user_message_id)
        started = time.monotonic()
        seq, tools_used, memory_used, graph_used, pending = 0, [], [], [], []
        trace_status = "completed"

        async def emit(kind: str, label: str, *, data=None, agent_id=None, status="succeeded", duration_ms=None):
            nonlocal seq
            seq += 1
            event = await self.repository.trace_event(trace_id, seq, kind, agent_id=agent_id,
                task_id=request.task_id, label=label, status=status, duration_ms=duration_ms, data=data)
            await self.hub.publish(event)
            return event

        try:
            if request.task_id:
                task = await self.repository.task(request.task_id)
                if not task:
                    raise ValueError("Task was not found.")
                if task["status"] in {"pending", "planning"}:
                    await self.task_manager.update(request.task_id, {"status": "active"})
                task = await self.repository.task(request.task_id)
            else:
                task = None
            all_agents = await self.repository.list_agents(enabled_only=True)
            if not all_agents:
                raise RuntimeError("No enabled agents are configured.")
            agent_rows = await self.repository.list_agents(enabled_only=False)
            agent_map = {item["id"]: item for item in agent_rows}
            requested = request.agent_id
            if requested:
                chosen = agent_map.get(requested)
                if not chosen or not chosen["enabled"] or chosen["status"] != "active":
                    raise ValueError("Requested agent is disabled or unavailable.")
                route_agent_id = requested
            else:
                global_result = await self.decision.decide("global", {"message": message, "requested_agent": None}, all_agents, [])
                global_answer = global_result["answers"].get("agent", {})
                route_agent_id = "general" if global_answer.get("mode") == "reason" else (global_answer.get("value") or "general")
                if route_agent_id not in {a["id"] for a in all_agents}:
                    route_agent_id = "general"
                await emit("routing", f"Routed request to {agent_map[route_agent_id]['name']}.", agent_id=route_agent_id,
                    data=global_result)

            agent = agent_map[route_agent_id]
            if request.task_id:
                await self.repository.db.execute("UPDATE tasks SET agent_id=COALESCE(agent_id,?),conversation_id=COALESCE(conversation_id,?),updated_at=? WHERE id=?",
                    (route_agent_id, conversation_id, now(), request.task_id))
                await self.repository.db.execute("INSERT OR IGNORE INTO task_assignees(task_id,agent_id,activity) VALUES(?,?,'Working on task')",
                    (request.task_id, route_agent_id))
            await self.repository.db.execute("UPDATE agents SET run_state='thinking' WHERE id=?", (route_agent_id,))
            await emit("agent.state", f"{agent['name']} started thinking.", agent_id=route_agent_id,
                data={"agent_id": route_agent_id, "run_state": "thinking"})
            grants = await self.repository.agent_tools(route_agent_id)
            state = {"agent_id": route_agent_id, "agent_name": agent["name"], "message": message,
                     "current_task": {"id": task["id"], "instruction": task["title"], "status": task["status"]} if task else None,
                     "active_plan": {"id": task["plan"]["id"], "objective": task["plan"].get("objective")} if task and task.get("plan") else None,
                     "available_tools": [t["name"] for t in grants],
                     "recent_context": "\n".join(m["content"] for m in await self.repository.recent_messages(conversation_id, 3)),
                     "entities": []}
            local_result = await self.decision.decide(agent["laya_profile"], state, all_agents, grants)
            await emit("decision", f"{agent['name']} selected context and tool policy.", agent_id=route_agent_id, data=local_result)

            answers = local_result["answers"]
            memories = []
            memory_decision = answers.get("needs_memory", {"value": False, "mode": "execute"})
            if should_retrieve(memory_decision):
                memories = await self.repository.retrieve_memories(route_agent_id, message, 5,
                    request.workspace_id or (task.get("workspace_id") if task else None))
                memory_used = [item["id"] for item in memories]
            await emit("memory", f"Retrieved {len(memories)} relevant memories.", agent_id=route_agent_id,
                data={"scanned": len(memories), "selected": len(memories), "ids": memory_used,
                      "token_estimate": sum((len(item["content"]) + 3) // 4 for item in memories)})

            graph = []
            graph_decision = answers.get("needs_graph", {"value": False, "mode": "execute"})
            if should_retrieve(graph_decision):
                graph = await self.repository.retrieve_graph(message, 8)
                graph_used = list(dict.fromkeys([part for row in graph for part in (row["source_id"], row["target_id"])]))
            await emit("jev", f"Retrieved {len(graph)} related knowledge facts.", agent_id=route_agent_id,
                data={"entities": len(graph_used), "relations": len(graph), "ids": graph_used})

            tool_decision = answers.get("tool", {"value": "none", "mode": "execute"})
            selected_tools = self.registry.select(grants, str(tool_decision.get("value", "none")), tool_decision.get("mode", "execute"))
            schemas = [tool.schema() for tool in selected_tools]
            await emit("tools", f"Selected {len(selected_tools)} tools for {agent['name']}.", agent_id=route_agent_id,
                data={"registered": len(self.registry.tools), "enabled": len(self.registry.tools), "granted": len(grants),
                      "relevant": len([t for t in grants if not tool_decision.get("value") or t["category"] == tool_decision["value"]]),
                      "selected": [tool.name for tool in selected_tools]})
            history = await self.repository.recent_messages(conversation_id, self.settings.context_recent_messages)
            context, context_metrics = self.context_builder.build(system_prompt=agent["system_prompt"] or "Be a helpful project agent.",
                objective=message, messages=history, task=task, plan=task.get("plan") if task else None,
                memories=memories, graph=graph, tool_schemas=schemas)
            await emit("context", "Built a bounded context for the model.", agent_id=route_agent_id, data=context_metrics)

            response_text = ""
            llm_decision = answers.get("needs_llm", {"value": True, "mode": "execute"})
            if not should_invoke_llm(llm_decision):
                response_text = "This request does not need a model response. Please ask for the project result you need."
            else:
                current_messages = context
                for iteration in range(self.settings.max_tool_iterations):
                    llm_started = time.monotonic()
                    try:
                        completion = await self.model.generate(current_messages, schemas, agent.get("model"))
                    except Exception as exc:
                        await emit("error", f"Main model request failed: {str(exc)[:240]}", agent_id=route_agent_id, status="failed")
                        response_text = f"The main model is unavailable: {str(exc)[:500]}"
                        break
                    usage = completion.get("usage", {})
                    await emit("llm", f"{agent['name']} generated a response.", agent_id=route_agent_id,
                        duration_ms=int((time.monotonic() - llm_started) * 1000),
                        data={"model": completion.get("model"), "usage": usage, "iteration": iteration + 1})
                    tool_calls = completion.get("tool_calls", [])
                    if not tool_calls:
                        response_text = str(completion.get("content") or "").strip()
                        break
                    current_messages.append({"role": "assistant", "content": completion.get("content") or "", "tool_calls": tool_calls})
                    stop_for_approval = False
                    for call in tool_calls:
                        function = call.get("function", {})
                        tool_name = function.get("name", "")
                        try:
                            arguments = json.loads(function.get("arguments") or "{}")
                        except json.JSONDecodeError:
                            arguments = {}
                        tool_context = ToolContext(agent_id=route_agent_id, conversation_id=conversation_id,
                            task_id=request.task_id, trace_id=trace_id, workspace_root=self.registry.workspace_root,
                            workspace_id=request.workspace_id or (task.get("workspace_id") if task else None))
                        result = await self.executor.execute(name=tool_name, arguments=arguments,
                            granted_names={tool.name for tool in selected_tools}, context=tool_context,
                            decision_mode=tool_decision.get("mode", "reason"), publish=self.hub.publish, seq=seq + 1)
                        seq += 1
                        if result["status"] == "succeeded":
                            tools_used.append(tool_name)
                        stored_tool_message = f"tool://{result['run_id']}\nsummary: {result['summary']}"
                        await self.repository.save_message(conversation_id, "tool", stored_tool_message, route_agent_id)
                        if result["pending"]:
                            pending.append(result["run_id"])
                            if request.task_id and task and task["status"] == "active":
                                task = await self.task_manager.update(request.task_id, {"status": "blocked"})
                            stop_for_approval = True
                            break
                        current_messages.append({"role": "tool", "tool_call_id": call.get("id", ""),
                                                 "name": tool_name, "content": result["content"]})
                    if stop_for_approval:
                        trace_status = "waiting"
                        response_text = "A requested file change is waiting for your approval."
                        break
                if not response_text:
                    response_text = "I couldn't produce a response for this request. Please try again."

            assistant_message_id = await self.repository.save_message(conversation_id, "assistant", response_text, route_agent_id)
            await self.repository.store_memory(route_agent_id, f"User: {message}\nAssistant: {response_text}",
                kind="episodic", workspace_id=request.workspace_id, conversation_id=conversation_id, source_message_id=assistant_message_id)
            fact = re.search(r"\b([A-Z][\w.-]{1,40})\s+(uses|depends on|owns)\s+([A-Z][\w.-]{1,40})\b", message)
            if fact:
                predicate = {"uses": "uses", "depends on": "depends_on", "owns": "owned_by"}[fact.group(2)]
                relation = await self.repository.upsert_relation("concept", fact.group(1), predicate, "concept", fact.group(3), user_message_id)
                if request.task_id:
                    for entity_id in (relation["source_id"], relation["target_id"]):
                        await self.repository.db.execute("INSERT OR IGNORE INTO task_entities(task_id,entity_id,weight) VALUES(?,?,1.0)",
                            (request.task_id, entity_id))
            await emit("memory", "Saved this turn as episodic memory.", agent_id=route_agent_id,
                data={"operation": "store", "type": "episodic"})
            await self.repository.db.execute("UPDATE agents SET run_state=? WHERE id=?", ("waiting" if pending else "idle", route_agent_id))
            if not pending:
                await emit("agent.state", f"{agent['name']} is idle.", agent_id=route_agent_id,
                    data={"agent_id": route_agent_id, "run_state": "idle"})
            return {"message": response_text, "conversation_id": conversation_id, "agent": route_agent_id,
                    "tools_used": tools_used, "memory_used": memory_used, "graph_used": graph_used,
                    "trace_id": trace_id, "task_id": request.task_id, "pending_approvals": pending}
        except Exception as exc:
            trace_status = "failed"
            await emit("error", f"Request failed: {str(exc)[:240]}", status="failed")
            raise
        finally:
            trace = await self.repository.get_trace(trace_id)
            metrics = {"event_count": len(trace["events"]) if trace else 0, "llm_invocations": sum(e["kind"] == "llm" for e in trace["events"]) if trace else 0,
                       "tool_runs": tools_used, "memory_ids": memory_used}
            await self.repository.finish_trace(trace_id, trace_status, started, metrics)
