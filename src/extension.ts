import * as vscode from "vscode";
import * as fs from "fs";
import { AgentDatabase } from "./database";
import { ModelProvider, OpenAICompatibleModel } from "./model";
import { Orchestrator } from "./orchestrator";
import { AgentsTreeProvider } from "./agentsTree";

export async function activate(context: vscode.ExtensionContext) {
  const storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const db = new AgentDatabase(storageDir);
  db.seedAgents();

  const model = new OpenAICompatibleModel(() => {
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    return {
      baseUrl: cfg.get<string>("baseUrl", "http://localhost:11434/v1"),
      apiKey: cfg.get<string>("apiKey", "local"),
      model: cfg.get<string>("model", "qwen3:8b"),
      providers: cfg.get<ModelProvider[]>("providers", []),
      activeProviderId: cfg.get<string>("activeProviderId", ""),
      activeModel: cfg.get<string>("activeModel", "")
    };
  });

  const tree = new AgentsTreeProvider(db);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentOrchestrator.agents", tree)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentOrchestrator.open", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "@orchestrator "
      });
    })
  );

  const participant = vscode.chat.createChatParticipant(
    "agentOrchestrator.chat",
    async (request, _chatContext, response, token) => {
      const instruction = request.prompt.trim();
      if (!instruction) {
        response.markdown("Tell me what you want the agent team to work on.");
        return;
      }

      const settings = vscode.workspace.getConfiguration("agentOrchestrator");
      const orchestrator = new Orchestrator(db, model, event => {
        if (token.isCancellationRequested) return;
        if (event.type === "delegate") {
          response.progress(`$(organization) ${event.text}`);
        } else if (event.type === "start" && event.agentId !== "lead") {
          response.progress(`$(sync~spin) ${event.agentId} is working...`);
        }
      }, undefined, {
        layaEnabled: settings.get<boolean>("layaEnabled", true),
        maxDelegationDepth: settings.get<number>("maxDelegationDepth", 3),
        maxDelegationsPerTask: settings.get<number>("maxDelegationsPerTask", 8),
        contextRecentMessages: settings.get<number>("contextRecentMessages", 6)
      });

      try {
        response.progress("$(sync~spin) Starting the agent team...");
        const result = await orchestrator.runRoot(instruction);
        if (!token.isCancellationRequested) response.markdown(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.markdown(`$(error) **Agent task failed:** ${message}`);
      }
    }
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "agents.svg");
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand("agentOrchestrator.runTask", async () => {
      const instruction = await vscode.window.showInputBox({
        title: "Run Multi-Agent Task",
        prompt: "What should the agent team do?",
        placeHolder: "Review this project and propose a database architecture..."
      });

      if (!instruction) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Agent Orchestrator",
          cancellable: false
        },
        async progress => {
          progress.report({ message: "Running lead agent..." });

          try {
            // Put the request in Chat; the participant handles execution there.
            await vscode.commands.executeCommand("workbench.action.chat.open", {
              query: `@orchestrator ${instruction}`
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Agent task failed: ${message}`);
          }
        }
      );
    })
  );
}

export function deactivate() {}
