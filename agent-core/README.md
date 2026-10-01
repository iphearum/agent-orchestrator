# Laya Agent Core

Standalone Python/FastAPI runtime for the Agent Workbench. The API listens on
`127.0.0.1:8765` by default and stores runtime state in SQLite.

```bash
cd agent-core
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -e .
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Configure `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME` for an
OpenAI-compatible chat-completions server. Laya is optional; when unavailable,
the configured fallback mode keeps the runtime usable and reports its status.
Filesystem tools are constrained to `WORKSPACE_ROOT`. Mutating file tools are
recorded as pending approval and only run after an explicit approval request.
