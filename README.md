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

```bash
npm install
npm run compile
```

Open the folder in VS Code and press `F5`.

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

ChatGPT API, Codex CLI, and Claude Code subscription/CLI authentication are separate transports from these API protocols; CLI-backed adapters are not included yet. For API endpoints, configure credentials and base URLs from the provider's API documentation.

## Standalone desktop workbench

The repository also includes an Electron workbench with a VS Code inspired layout, Monaco
editor, workspace explorer, xterm.js terminal, agent chat, agent profiles, and model/runtime
settings. It uses the same TypeScript orchestrator and SQLite database as the VS Code extension.

```bash
npm install
npm run desktop:dev
```

Use **Open Folder** to select a workspace. The integrated terminal starts in that folder;
agent profile and model settings are saved under Electron's application data directory.
The standalone renderer runs with context isolation enabled and sends file, terminal, and
agent operations to the desktop main process through a narrow preload API. The terminal uses
the platform prebuilt files shipped in Microsoft's `node-pty` package; the app does not force
a local Electron rebuild. Its native files are unpacked from the app archive at packaging
time. Run `npm run desktop:dist` to create a platform installer in `release/`.

The extension uses the Node runtime's built-in `node:sqlite` API. The database is created at
the extension's global storage location as `runtime.db`; SQLite is the source of truth and
vector retrieval can be added later as a projection. The bundled Laya-compatible decision
layer is deliberately small and deterministic, so the runtime remains useful without loading
a second model. `LayaRuntime` can be replaced with the installed Laya adapter when one is
available.

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
