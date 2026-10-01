# Agent Orchestrator

A SQLite-first VS Code multi-agent runtime with a shared decision layer and per-agent policies.

## Features

- SQLite-backed conversations, agents, memories, tasks, plans, tool runs and traces
- Agent-to-agent delegation
- Dynamic agent discovery by capability
- Global routing plus coder, researcher and planner decision policies
- Conditional memory and JEV entity retrieval with compact context construction
- Task/message history
- Multiple named model providers and selectable models
- OpenAI-compatible chat completions and Anthropic Messages APIs
- Per-agent system prompts and skills
- Delegation depth and delegation-count guards
- VS Code Activity Bar tree
- Command to run a task

## Run

### Build and install the VS Code extension

Run these commands from the repository root:

```bash
npm install
npm run compile
npm run package
```

`npm run package` creates `agent-orchestrator-0.1.0.vsix` in the repository root. Install it in VS Code from a terminal:

```bash
code --install-extension agent-orchestrator-0.1.0.vsix
```

To update or reinstall after building a new VSIX, force-install the package:

```bash
npm run package
code --install-extension agent-orchestrator-0.1.0.vsix --force
```

To uninstall the extension:

```bash
code --uninstall-extension local.agent-orchestrator
```

To develop and launch the extension in an Extension Development Host, open this folder in VS Code and press `F5`. For a quick compile without packaging, run `npm run compile`; `npm run watch` recompiles as files change.

On Windows PowerShell, if execution policy prevents the `npm` script from running, use `npm.cmd` in place of `npm` in these commands. The `code` command must be available on your `PATH`; use `code-insiders` for VS Code Insiders.

Configure:

```json
{
  "agentOrchestrator.baseUrl": "http://localhost:11434/v1",
  "agentOrchestrator.apiKey": "local",
  "agentOrchestrator.model": "qwen3:8b"
}
```

In the desktop workbench, open **Settings → Model providers** to add multiple endpoints and models, then choose the active provider and model from the chat composer. Providers can use OpenAI-compatible `/chat/completions` APIs or Anthropic Messages APIs. Ollama, Qwen, and Unsloth endpoints can be configured using their OpenAI-compatible URL and model identifiers.

In the VS Code extension, configure provider entries in settings:

```json
{
  "agentOrchestrator.providers": [
    {
      "id": "ollama",
      "name": "Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "local",
      "models": ["qwen3:8b", "qwen3:32b"],
      "model": "qwen3:8b"
    },
    {
      "id": "anthropic",
      "name": "Anthropic",
      "protocol": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "YOUR_API_KEY",
      "models": ["claude-sonnet-4-5"],
      "model": "claude-sonnet-4-5"
    }
  ],
  "agentOrchestrator.activeProviderId": "ollama",
  "agentOrchestrator.activeModel": "qwen3:8b"
}
```

Add persistent remote agent runtimes in `agentOrchestrator.socketLinks`. Agents can be
assigned to a local model, an n8n webhook, or a WebSocket runtime from **Agent Orchestrator:
Manage Agents**. Configure connection tokens with **Agent Orchestrator: Configure Socket
Token**; tokens are kept in VS Code Secret Storage.

The WebSocket transport uses one JSON message per request and response. The client sends:

```json
{
  "type": "agent.execute",
  "requestId": "task-id",
  "taskId": "task-id",
  "rootTaskId": "root-task-id",
  "conversationId": "conversation-id",
  "depth": 1,
  "agent": { "id": "researcher", "name": "Researcher", "description": "...", "skills": ["research"] },
  "instruction": "Research this question",
  "auth": { "bearerToken": "..." }
}
```

The server responds with `{"type":"agent.result","requestId":"task-id","output":"..."}`
or `{"type":"agent.error","requestId":"task-id","error":"..."}`. It may send
`agent.progress` messages while running. Use `wss://` for remote connections; plain `ws://`
is accepted only for localhost. The socket is reused across tasks, and each request has a
timeout.

## External tools (MCP) and coding-agent CLIs

### MCP servers as agent tools

Agents can use tools from MCP servers you add to VS Code (**MCP: Add Server**). VS Code starts the servers and handles trust and sign-in; the orchestrator reads them from VS Code's tool registry.

- Each turn an agent sees only a few tools relevant to its task, plus `find_tools` to search for more. Dozens of tool definitions per request would overwhelm the model.
- External tools ask for approval unless the chat is in **Full access** mode or the tool is listed in `agentOrchestrator.externalTools.autoApprove`.
- Every call is recorded in the task view like any other tool run.
- Run **Agent Orchestrator: Show External Tools (MCP)** to see which tools exist and which agents can use them.

```json
{
  "agentOrchestrator.externalTools.toolPatterns": ["mcp_*"],
  "agentOrchestrator.externalTools.agentTools": {
    "devops": ["mcp_github_*", "mcp_kubernetes_*"],
    "researcher": ["mcp_fetch_*"],
    "*": []
  },
  "agentOrchestrator.externalTools.autoApprove": ["mcp_github_get_*", "mcp_github_list_*"]
}
```

### Coding-agent CLIs as agents

An agent can hand its whole task to a coding-agent CLI such as Claude Code or the OpenAI Codex CLI. The CLI runs in the workspace with its own tools and permissions; its tool use streams into the chat and task view, and its final answer becomes the agent's result. Other agents can still delegate to it.

```json
{
  "agentOrchestrator.cliAgents": [
    { "id": "claude-code", "name": "Claude Code", "preset": "claude-code" },
    { "id": "codex", "name": "Codex", "preset": "codex" },
    { "id": "aider", "name": "Aider", "preset": "custom", "command": "aider", "args": ["--message", "{prompt}", "--yes"] }
  ]
}
```

Then assign one to an agent: **Agent Orchestrator: Manage Agents → (agent) → Agent runtime → CLI · Claude Code**.

The chat's approval mode maps onto the CLI's own permission setting:

| Chat approval mode | Claude Code | Codex |
|---|---|---|
| Ask for approval | `--permission-mode plan` (reads, no changes) | `--sandbox read-only` |
| Approve for me | `--permission-mode acceptEdits` | `--sandbox workspace-write` |
| Full access | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` |

The CLI must be installed and signed in, and be on the `PATH` that VS Code sees. On Windows the task is passed on stdin rather than the command line.

## Laya decision service

The extension can call a Jev-compatible Laya SystemOne service for global agent routing,
per-agent memory/graph retrieval decisions, and first-capability tool selection. The API
accepts `POST /v1/systemone` with `{ "state": ..., "questions": ... }`; Laya answers are
typed choices with confidences. The extension uses neutral A/B choice questions for yes/no
decisions rather than the `noul` primitive, and never treats a Laya decision as permission
to run a protected tool.

Start a local service using the upstream `laya[serve]` package, then set
`agentOrchestrator.layaEndpoint` (for example `http://localhost:8000/v1/systemone`). For a
remote service, use HTTPS. Store a bearer key with **Agent Orchestrator: Configure Laya API
Key**, then use **Agent Orchestrator: Test Laya Connection**. For services that host several models, set
`agentOrchestrator.layaModel` (for example `laya-multilingual`); it is sent as `model` with
each request. Yes/no questions are sent as native `noul` questions, and both `noul`
probabilities and older `yes`/`no` choice answers are understood. In the desktop app, set the
same values under **Settings → Agent orchestration**.

If a Laya request fails (for example it times out), Laya is paused and every decision uses the fallback
(`agentOrchestrator.layaFallbackMode`, `rules` recommended) without waiting on Laya again. While paused, one small
request is sent every `agentOrchestrator.layaRetryMinutes` (default 5, `0` = manual only); Laya resumes when it
answers. Resume it yourself with **Agent Orchestrator: Resume Laya**, the Laya status bar item, or the chat's
**Resume** button. Team-planning questions are only sent for requests that look like multi-agent work, which keeps
the usual routing request small. Configure
`agentOrchestrator.layaFallbackMode` as `none` to keep the Lead agent and skip optional
retrieval when Laya is absent, or `rules` to use the built-in deterministic routing rules.
The main LLM and permission-filtered tools remain available in either fallback mode.

The **Monitor** view is a task workbench with an agent flow, saved plans, file writes,
timeline, tool activity, and task/agent details. Its Agents, Knowledge, Memory, and Tools
sections read from the same SQLite runtime records. Workspace file writes ask for approval by
default; `approvalMode: "full"` also exposes unrestricted shell commands started in the
workspace directory. Progress and file changes are shown only when recorded; the view does not
invent test counts, line diffs, or latency metrics the runtime has not collected.

ChatGPT API, Codex CLI, and Claude Code subscription/CLI authentication are separate transports from these API protocols; CLI-backed adapters are not included yet. For API endpoints, configure credentials and base URLs from the provider's API documentation.

## Standalone desktop workbench

The Electron workbench opens the Agent Orchestration screen based on
`target/real_ui_design.png`. It shows live tasks, agent flow, work events, tool calls,
file changes, related knowledge, and runtime status. The existing editor, workspace
explorer, terminal, and chat remain available from the **Editor** button.

Start the standalone Python/FastAPI runtime in a separate terminal:

```bash
cd agent-core
python -m venv .venv
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -e .
cp .env.example .env
python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Configure the API in `agent-core/.env` using `.env.example`, then start the desktop renderer:

```bash
npm install
npm run desktop:dev
```

The runtime stores data in `agent-core/data/runtime.db` by default. Set `MODEL_BASE_URL`,
`MODEL_API_KEY`, and `MODEL_NAME` to use an OpenAI-compatible endpoint. Laya can use
`LAYA_ENDPOINT`; rules fallback is available when it is unconfigured or offline. Workspace
write tools wait for approval in the workbench. Use `npm run desktop:dist` to create an
Electron installer in `release/`.

The Python runtime is the source of truth for the new desktop workbench. It stores messages,
agent state, tasks, memory, JEV relations, tool runs, and trace events in SQLite. Vector
retrieval is disabled by default. The VS Code extension still has its independent TypeScript
runtime and can be used on its own.

## Architecture

The model is never allowed to directly create OS processes for sub-agents.
Instead, it emits structured tool calls:

- `list_agents`
- `find_agent`
- `ask_agent`
- `delegate_task`

The orchestrator validates and executes them.

The current implementation uses one VS Code extension host process. Tool execution remains
orchestrator-owned and authorization is never delegated to an agent. For strong isolation,
add Docker/Podman or Git-worktree sandboxes before adding autonomous shell execution.
"# agent-orchestrator" 

## Project structure

- `agent-core/app/main.py` is the FastAPI entry point for the desktop workbench runtime.
- `agent-core/app/core/` contains settings, context construction, events, and orchestration.
- `agent-core/app/decision/` contains the shared Laya client and per-agent policies.
- `agent-core/app/storage/` contains the SQLite connection, migrations, and repositories.
- `agent-core/app/tools/` contains the registry, workspace tools, and approval executor.
- `backend/src/extension.ts` is the independent VS Code extension activation entry point.
- `backend/src/core/` contains agent orchestration, model adapters, routing, shared types, the task queue and agent messaging.
- `backend/src/integrations/` contains optional Laya, n8n and WebSocket connections.
- `backend/src/persistence/` contains SQLite storage.
- `backend/src/tools/` contains workspace and shell tools.
- `backend/src/vscode/` contains VS Code views and chat UI adapters.
- `frontend/templates/workbench.html` is the lightweight workbench HTML template; `frontend/styles/` contains its CSS.
- `desktop/renderer-next/` is the Next.js renderer. The root route is the live orchestration workbench; `/editor` preserves the existing editor UI.
- `desktop/` contains the Electron host and packaging configuration.

The extension compiles from `backend/src/` to `dist/`. The desktop renderer is built separately from `desktop/renderer-next/`.
