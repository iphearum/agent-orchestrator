# Install and configure Agent Orchestration Studio

## Requirements

- Visual Studio Code 1.104.0 or later.
- A model provider endpoint and model. The extension does not include or host a model.
- Network access to the provider you configure. Local provider endpoints are supported.

Laya routing, embeddings, VS Code external tools, and remote agent runtimes are optional.

## Install from a VSIX file

1. Download the Agent Orchestration Studio `.vsix` file.
2. In VS Code, open the Command Palette with **Ctrl+Shift+P** (Windows/Linux) or **Cmd+Shift+P** (macOS).
3. Run **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file and reload VS Code if prompted.

You can also install from a terminal:

```powershell
code --install-extension "agent-orchestration-studio-0.1.2.vsix"
```

Replace the example path with the location of the VSIX you downloaded.

## Connect a model provider

1. Open **Preferences: Open User Settings (JSON)** from the Command Palette, or use **Agent Orchestration Studio: Open Settings**.
2. Add a provider entry and select it as the active provider. For example:

```jsonc
{
  "agentOrchestrator.providers": [
    {
      "id": "main",
      "name": "My Model Provider",
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "<your-model-id>",
      "models": ["<your-model-id>"]
    }
  ],
  "agentOrchestrator.activeProviderId": "main",
  "agentOrchestrator.activeModel": "<your-model-id>"
}
```

Replace `<your-model-id>` with a model available from your provider. For a local OpenAI-compatible server, replace `baseUrl` with that server's API URL. Set `protocol` to `anthropic` when using an Anthropic-compatible provider.

3. Run **Agent Orchestration Studio: Configure Provider API Key**, select the provider, and enter its API key. The extension stores this key in VS Code Secret Storage; do not put it in `settings.json`.
4. In a chat, select **Agent Orchestration Studio: Open Agentic** or run **Agent Orchestration Studio: Open**. Send a small prompt to confirm the provider is responding.

You can also assign a different provider or model to an individual agent with **Agent Orchestration Studio: Manage Agents**.

## Start a task

- **Agent Orchestration Studio: Open** opens the `@orchestrator` chat participant.
- **Agent Orchestration Studio: Open Agentic** opens the Agentic chat view.
- **Agent Orchestration Studio: Run Task** starts a task from a prompt.

The default approval mode is **Ask**. The chat approval selector also offers **Approve for me** and **Full access**. Full access makes shell commands available with the current user's permissions. Check the selected mode before giving an agent work that can change files or run commands.

## Optional Laya routing

1. Set `agentOrchestrator.layaEndpoint` to your Laya SystemOne endpoint.
2. Run **Agent Orchestration Studio: Configure Laya API Key** to store its key securely.
3. Run **Agent Orchestration Studio: Test Laya Connection**.

Laya is optional. Set `agentOrchestrator.layaEnabled` to `false` to turn it off. When Laya is unavailable, the extension uses its configured fallback behavior.

## Optional external tools and agents

- **VS Code tools / MCP:** enable `agentOrchestrator.externalTools.enabled` and configure tool patterns or agent grants if needed. External tools must already be available in VS Code.
- **Coding-agent CLIs:** install the CLI first, then configure `agentOrchestrator.cliAgents` and assign it under **Manage Agents**. The extension supports Claude Code, Codex, and custom commands.
- **n8n:** add a webhook under `agentOrchestrator.n8nLinks`, assign it to an agent, then run **Agent Orchestration Studio: Configure n8n Token** if the workflow requires a token.
- **WebSocket agent service:** add a `wss://` URL under `agentOrchestrator.socketLinks` (`ws://` is allowed for localhost), assign it to an agent, and store its token with **Agent Orchestration Studio: Configure Socket Token**.

## Troubleshooting

- **No model response:** verify the provider URL, protocol, model ID, network access, and saved API key.
- **Provider key command shows no choices:** add the provider under `agentOrchestrator.providers` first.
- **Laya is not connected:** check the endpoint and key, then run **Test Laya Connection**. You can disable Laya and use the fallback behavior.
- **An external tool is missing:** make sure it is registered in VS Code, matches `agentOrchestrator.externalTools.toolPatterns`, and is granted to the agent.
- **A CLI agent cannot start:** install the CLI and make sure VS Code can find it on `PATH`.

