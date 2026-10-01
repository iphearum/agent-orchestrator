import json

from app.domain.ids import new_id
from app.storage.sqlite import Database

AGENTS = [
    ("supervisor", "Supervisor", "Routes requests and coordinates work.", "global", "violet", 0, 0),
    ("coder", "Coder", "Inspects and changes project code.", "coder", "green", 1, 1),
    ("general", "General", "Handles requests without a specialist.", "general", "blue", 1, 1),
    ("researcher", "Researcher", "Investigates sources and project context.", "researcher", "blue", 0, 0),
    ("planner", "Planner", "Breaks objectives into ordered work.", "planner", "teal", 0, 0),
    ("reviewer", "Reviewer", "Reviews changes for correctness.", "reviewer", "amber", 0, 0),
    ("devops", "DevOps", "Handles infrastructure and operations.", "devops", "orange", 0, 0),
    ("documenter", "Documenter", "Writes and maintains documentation.", "documenter", "lavender", 0, 0),
]

TOOLS = [
    ("expand_ref", "Expand a stored tool, memory, or entity reference.", "workspace_read", "Expand Reference", 0, 0,
     {"type": "object", "properties": {"ref": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 4000}}, "required": ["ref"]}),
    ("read_file", "Read a UTF-8 file inside the selected workspace.", "workspace_read", "Read File", 0, 0,
     {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
    ("search_code", "Search project text files for a phrase.", "workspace_read", "Search Code", 0, 0,
     {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 30}}, "required": ["query"]}),
    ("write_file", "Write a file inside the selected workspace after approval.", "workspace_write", "Write File", 1, 1,
     {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}),
]


async def seed_database(db: Database, workspace_root: str) -> None:
    workspace = await db.one("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")
    workspace_id = workspace["id"] if workspace else new_id("WS")
    await db.execute("INSERT OR IGNORE INTO workspaces(id,name,root_path) VALUES(?,?,?)", (workspace_id, "Workspace", workspace_root))
    for agent_id, name, description, profile, color, enabled, active in AGENTS:
        await db.execute(
            """INSERT OR IGNORE INTO agents(id,name,description,system_prompt,laya_profile,status,enabled,color,sort_order)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (agent_id, name, description, f"You are {name}. {description} Be concise, accurate, and use tools only when needed.", profile,
             "active" if active else "disabled", enabled, color, next(index for index, row in enumerate(AGENTS) if row[0] == agent_id)),
        )
    for name, description, category, display, risk, approval, schema in TOOLS:
        tool_id = f"tool-{name}"
        await db.execute(
            """INSERT OR IGNORE INTO tools(id,name,description,schema_json,category,display_name,risk_level,requires_approval,enabled)
               VALUES(?,?,?,?,?,?,?,?,1)""",
            (tool_id, name, description, json.dumps(schema), category, display, risk, approval),
        )
        grant_agents = [agent[0] for agent in AGENTS] if name == "expand_ref" else ["coder", "general"]
        for agent_id in grant_agents:
            await db.execute("INSERT OR IGNORE INTO agent_tools(agent_id,tool_id,priority) VALUES(?,?,?)", (agent_id, tool_id, 1.0))
