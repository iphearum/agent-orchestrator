import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.tools.base import Tool, ToolContext, ToolResult


class ReadFileArgs(BaseModel):
    path: str


class SearchArgs(BaseModel):
    query: str
    limit: int = Field(default=20, ge=1, le=30)


class WriteFileArgs(BaseModel):
    path: str
    content: str


class ExpandRefArgs(BaseModel):
    ref: str
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=3000, ge=1, le=4000)


SKIP_DIRS = {".git", ".next", ".venv", "node_modules", "dist", "out", "release", "__pycache__"}


def safe_path(root: Path, relative: str, *, allow_new: bool = False) -> Path:
    base = root.resolve()
    raw = Path(relative)
    if raw.is_absolute():
        raise ValueError("Tool paths must be workspace-relative.")
    candidate = (base / raw).resolve(strict=not allow_new)
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise ValueError("Tool paths must stay inside the selected workspace.") from exc
    if allow_new:
        parent = candidate.parent
        while not parent.exists() and parent != base:
            parent = parent.parent
        parent = parent.resolve(strict=True)
        try:
            parent.relative_to(base)
        except ValueError as exc:
            raise ValueError("Tool paths must stay inside the selected workspace.") from exc
    return candidate


class ReadFileTool(Tool):
    name, category, display_name, risk_level, requires_approval = "read_file", "workspace_read", "Read File", 0, False
    description, args_model = "Read a UTF-8 file inside the selected workspace.", ReadFileArgs

    async def execute(self, args: ReadFileArgs, ctx: ToolContext) -> ToolResult:
        path = safe_path(ctx.workspace_root, args.path)
        if not path.is_file() or path.stat().st_size > 300_000:
            raise ValueError("File is missing or larger than 300 KB.")
        content = path.read_text(encoding="utf-8", errors="replace")
        return ToolResult(ok=True, data={"path": args.path, "content": content}, summary=f"Read {args.path} ({len(content)} characters).")


class SearchCodeTool(Tool):
    name, category, display_name, risk_level, requires_approval = "search_code", "workspace_read", "Search Code", 0, False
    description, args_model = "Search project text files for a phrase.", SearchArgs

    async def execute(self, args: SearchArgs, ctx: ToolContext) -> ToolResult:
        query = args.query.strip().casefold()
        if len(query) < 2:
            return ToolResult(ok=True, data={"results": []}, summary="Search query was too short.")
        matches: list[dict[str, Any]] = []
        scanned = 0
        extensions = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".sql", ".css", ".html", ".yml", ".yaml", ".toml", ".txt"}
        for directory, dirs, files in __import__("os").walk(ctx.workspace_root, followlinks=False):
            dirs[:] = [name for name in dirs if name not in SKIP_DIRS and not (Path(directory) / name).is_symlink()]
            for filename in files:
                path = Path(directory) / filename
                if path.suffix.casefold() not in extensions or path.is_symlink():
                    continue
                try:
                    if path.stat().st_size > 256_000 or scanned + path.stat().st_size > 16_000_000:
                        continue
                    scanned += path.stat().st_size
                    for line_number, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if query in line.casefold():
                            matches.append({"path": path.relative_to(ctx.workspace_root).as_posix(), "line": line_number, "snippet": line.strip()[:240]})
                            if len(matches) >= args.limit:
                                break
                except OSError:
                    continue
                if len(matches) >= args.limit:
                    break
            if len(matches) >= args.limit:
                break
        summary = f"Found {len(matches)} matching lines for {args.query!r}."
        return ToolResult(ok=True, data={"results": matches}, summary=summary)


class WriteFileTool(Tool):
    name, category, display_name, risk_level, requires_approval = "write_file", "workspace_write", "Write File", 1, True
    description, args_model = "Write a file inside the selected workspace after approval.", WriteFileArgs

    async def execute(self, args: WriteFileArgs, ctx: ToolContext) -> ToolResult:
        import difflib
        path = safe_path(ctx.workspace_root, args.path, allow_new=True)
        before = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        diff = "".join(difflib.unified_diff(before.splitlines(True), args.content.splitlines(True),
                    fromfile=f"a/{args.path}", tofile=f"b/{args.path}"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args.content, encoding="utf-8")
        added = sum(line.startswith("+") and not line.startswith("+++") for line in diff.splitlines())
        deleted = sum(line.startswith("-") and not line.startswith("---") for line in diff.splitlines())
        return ToolResult(ok=True, data={"path": args.path}, summary=f"Updated {args.path}.", file_changes=[
            {"path": args.path, "before_text": before, "diff_text": diff, "additions": added, "deletions": deleted}
        ])


class ExpandRefTool(Tool):
    name, category, display_name, risk_level, requires_approval = "expand_ref", "workspace_read", "Expand Reference", 0, False
    description, args_model = "Expand a stored tool, memory, or entity reference.", ExpandRefArgs

    def __init__(self, repository):
        self.repository = repository

    async def execute(self, args: ExpandRefArgs, ctx: ToolContext) -> ToolResult:
        if args.ref.startswith("tool://"):
            run = await self.repository.tool_run(args.ref.removeprefix("tool://"))
            if not run or (run.get("conversation_id") != ctx.conversation_id and not (ctx.task_id and run.get("task_id") == ctx.task_id)):
                raise ValueError("Tool result reference is unavailable in this conversation.")
            content = json.dumps(run.get("result") or {}, ensure_ascii=False, indent=2)
        elif args.ref.startswith("memory://"):
            memory = await self.repository.db.one("""SELECT * FROM memories WHERE id=? AND active=1
                AND (workspace_id IS NULL OR workspace_id=?)""", (args.ref.removeprefix("memory://"), ctx.workspace_id))
            if not memory or (memory.get("agent_id") != ctx.agent_id and memory.get("scope") != "global"):
                raise ValueError("Memory reference is unavailable to this agent.")
            content = memory["content"]
        elif args.ref.startswith("entity://"):
            entity_id = args.ref.removeprefix("entity://")
            entity = await self.repository.db.one("SELECT * FROM entities WHERE id=?", (entity_id,))
            if not entity:
                raise ValueError("Entity reference was not found.")
            relations = await self.repository.db.all("""SELECT s.name AS source,r.predicate,t.name AS target,r.confidence
                FROM relations r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id
                WHERE r.active=1 AND (r.source_id=? OR r.target_id=?) ORDER BY r.confidence DESC LIMIT 30""", (entity_id, entity_id))
            content = json.dumps({"entity": entity, "relations": relations}, ensure_ascii=False, indent=2)
        else:
            raise ValueError("Reference must use tool://, memory://, or entity://.")
        page = content[args.offset:args.offset + args.limit]
        summary = f"Expanded {args.ref} characters {args.offset}–{args.offset + len(page)} of {len(content)}."
        return ToolResult(ok=True, data={"ref": args.ref, "offset": args.offset, "total_chars": len(content), "content": page}, summary=summary)


class ToolRegistry:
    def __init__(self, workspace_root: Path, repository=None):
        tools = [ReadFileTool(), SearchCodeTool(), WriteFileTool()]
        if repository:
            tools.append(ExpandRefTool(repository))
        self.tools: dict[str, Tool] = {tool.name: tool for tool in tools}
        self.workspace_root = workspace_root

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    def select(self, grants: list[dict[str, Any]], choice: str, mode: str) -> list[Tool]:
        granted = [self.tools[row["name"]] for row in grants if row["name"] in self.tools]
        if choice == "none" and mode == "execute":
            return []
        if mode == "execute":
            selected = [tool for tool in granted if tool.category == choice]
        else:
            primary = [tool for tool in granted if tool.category == choice] if choice != "none" else []
            secondary = [tool for tool in granted if tool not in primary]
            selected = primary + secondary
        return selected[:3]

    async def invoke(self, name: str, args: dict[str, Any], context: ToolContext) -> ToolResult:
        tool = self.get(name)
        if not tool:
            raise ValueError(f"Unknown tool {name!r}.")
        parsed = tool.args_model.model_validate(args)
        return await tool.execute(parsed, context)
