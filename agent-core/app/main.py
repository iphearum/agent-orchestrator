from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import get_settings
from app.core.events import EventHub
from app.core.orchestrator import Orchestrator
from app.decision.engine import AgentDecisionEngine
from app.decision.laya_runtime import LayaRuntime
from app.models.openai_compatible import OpenAICompatibleModel
from app.storage.repositories import Repository
from app.storage.seed import seed_database
from app.storage.sqlite import Database
from app.tasks.manager import TaskManager
from app.tools.executor import ToolExecutor
from app.tools.registry import ToolRegistry

settings = get_settings()


@asynccontextmanager
async def lifespan(application: FastAPI):
    db = Database(settings.database_path, Path(__file__).resolve().parents[1] / "migrations")
    await db.open()
    await seed_database(db, str(settings.workspace_path))
    repository = Repository(db)
    workspace = await db.one("SELECT root_path FROM workspaces ORDER BY created_at LIMIT 1")
    workspace_root = Path(workspace["root_path"]).resolve() if workspace and workspace.get("root_path") else settings.workspace_path
    if not workspace_root.is_dir():
        workspace_root = settings.workspace_path
    hub = EventHub()
    task_manager = TaskManager(repository, hub)
    laya = LayaRuntime(settings)
    decision = AgentDecisionEngine(laya, settings)
    model = OpenAICompatibleModel(settings)
    registry = ToolRegistry(workspace_root, repository)
    executor = ToolExecutor(registry, repository, task_manager)
    application.state.settings = settings
    application.state.db = db
    application.state.repository = repository
    application.state.hub = hub
    application.state.task_manager = task_manager
    application.state.laya = laya
    application.state.model = model
    application.state.registry = registry
    application.state.executor = executor
    application.state.orchestrator = Orchestrator(settings, repository, decision, registry, executor, model, hub, task_manager)
    try:
        yield
    finally:
        await laya.close()
        await model.close()
        await db.close()


app = FastAPI(title="Laya Agent Core", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
                   allow_headers=["Content-Type", "Last-Event-ID"], allow_credentials=False)
app.include_router(router, prefix="/api/v1")
