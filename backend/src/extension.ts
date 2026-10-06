import * as vscode from "vscode";
import * as fs from "fs";
import { AgentDatabase } from "./persistence/database";
import { ModelProvider, OpenAICompatibleModel } from "./core/model";
import { ChatRunOptions, Orchestrator, RunEvent } from "./core/orchestrator";
import { RuntimeActivity } from "./core/activity";
import { Workbench } from "./vscode/webviews/workbench";
import { SessionRepository } from "./storage/repositories/sessions";
import { TaskQueue } from "./core/taskQueue";
import { CHAT_VIEW_ID, ChatComposerConfig, ChatComposerSelection, ChatModelOption, ChatWindowProvider } from "./vscode/chatWindow";
import { N8nAgentLink, N8nTransport } from "./integrations/n8nTransport";
import { AgentDefinition } from "./core/types";
import { AgentMessageBus } from "./core/agentMessageBus";
import { SocketAgentLink, SocketAgentTransport } from "./integrations/socketTransport";
import { AgentDecisionEngine } from "./core/decision";
import { LayaHttpClient, shouldRetryLaya } from "./integrations/layaClient";
import { WorkspaceTools } from "./tools/workspaceTools";
import { runWorkspaceCommand } from "./tools/shellTools";
import { showExternalTools, VsCodeToolHost } from "./vscode/lmTools";
import { CliAgentTransport, type CliAgentLink } from "./integrations/cliAgentTransport";
import { DiscussionService, assignmentInstruction } from "./core/discussion";
import { resolveReasoning } from "./core/reasoning";
import { decideDiscussion } from "./decision/policies/discussion";

export async function activate(context: vscode.ExtensionContext) {
  const storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const db = new AgentDatabase(storageDir);
  db.seedAgents();
  const activity = new RuntimeActivity();

  const laya = new LayaHttpClient(async () => {
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    return {
      endpoint: cfg.get<string>("layaEndpoint", ""),
      model: cfg.get<string>("layaModel", ""),
      apiKey: await context.secrets.get("agentOrchestrator.laya.apiKey"),
      timeoutMs: cfg.get<number>("layaTimeoutMs", 5000),
      keepAlive: cfg.get<string>("layaKeepAlive", "")
    };
  });

  const model = new OpenAICompatibleModel(async () => {
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    const providers = cfg.get<ModelProvider[]>("providers", []);
    const providersWithSecrets = await Promise.all(providers.map(async provider => ({
      ...provider,
      apiKey: await context.secrets.get(`agentOrchestrator.provider.${provider.id}.apiKey`) || provider.apiKey || ""
    })));
    return {
      baseUrl: cfg.get<string>("baseUrl", "http://localhost:11434/v1"),
      apiKey: cfg.get<string>("apiKey", "local"),
      model: cfg.get<string>("model", "qwen3:8b"),
      providers: providersWithSecrets,
      activeProviderId: cfg.get<string>("activeProviderId", ""),
      activeModel: cfg.get<string>("activeModel", "")
    };
  });
  db.markInterruptedQueueRuns();
  const queue = new TaskQueue(vscode.workspace.getConfiguration("agentOrchestrator").get<number>("maxConcurrentTasks", 2), event => db.saveQueueRun(event));
  context.subscriptions.push(queue);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("agentOrchestrator.maxConcurrentTasks")) {
      queue.setConcurrency(vscode.workspace.getConfiguration("agentOrchestrator").get<number>("maxConcurrentTasks", 2));
    }
  }));
  const messageBus = new AgentMessageBus();
  context.subscriptions.push(messageBus);
  const n8n = new N8nTransport(async linkId => {
    const links = vscode.workspace.getConfiguration("agentOrchestrator").get<N8nAgentLink[]>("n8nLinks", []);
    const link = links.find(item => item.id === linkId);
    if (!link) return undefined;
    return { link, bearerToken: await context.secrets.get(`agentOrchestrator.n8n.${link.id}.token`) };
  });
  const socket = new SocketAgentTransport(async linkId => {
    const links = vscode.workspace.getConfiguration("agentOrchestrator").get<SocketAgentLink[]>("socketLinks", []);
    const link = links.find(item => item.id === linkId);
    if (!link) return undefined;
    return { link, bearerToken: await context.secrets.get(`agentOrchestrator.socket.${link.id}.token`) };
  });
  context.subscriptions.push(socket);
  const workspaceTools = new WorkspaceTools();
  // MCP servers and other extension tools, through VS Code's tool registry.
  const externalTools = new VsCodeToolHost();
  // Coding-agent CLIs (Claude Code, Codex, custom) that can run an agent's whole task.
  const cliLinks = () => vscode.workspace.getConfiguration("agentOrchestrator").get<CliAgentLink[]>("cliAgents", []);
  const cliAgents = new CliAgentTransport(linkId => cliLinks().find(link => link.id === linkId), () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  const runPrompt = async (instruction: string, onEvent: (message: string, event?: RunEvent) => void, rootAgentId = "lead", autoRoute = true, runOptions: ChatRunOptions = {}) => {
    const settings = vscode.workspace.getConfiguration("agentOrchestrator");
    const layaEnabled = settings.get<boolean>("layaEnabled", true);
    const decisions = new AgentDecisionEngine(undefined, layaEnabled ? laya : undefined, settings.get<"none" | "rules">("layaFallbackMode", "none"));
    let rootTaskId: string | undefined;
    const orchestrator = new Orchestrator(db, model, event => {
      rootTaskId ??= event.rootTaskId;
      activity.handle(event);
      onEvent(event.text, event);
    }, decisions, {
      layaEnabled: settings.get<boolean>("layaEnabled", true),
      maxDelegationDepth: settings.get<number>("maxDelegationDepth", 3),
      maxDelegationsPerTask: settings.get<number>("maxDelegationsPerTask", 8),
      contextRecentMessages: settings.get<number>("contextRecentMessages", 6),
      contextMaxTokens: settings.get<number>("contextMaxTokens", 12000),
      vectorEnabled: settings.get<boolean>("vectorEnabled", false),
      automaticExecutionConfidence: settings.get<number>("automaticExecutionConfidence", .9),
      contextEnrichmentConfidence: settings.get<number>("contextEnrichmentConfidence", .65),
      maxAgentRunsPerRequest: settings.get<number>("maxAgentRunsPerRequest", 12)
    }, async request => {
      let target = request.toolName;
      try {
        const args = JSON.parse(request.argumentsJson || "{}");
        if (typeof args.path === "string") target += ` \u00b7 ${args.path}`;
        else if (typeof args.name === "string") target += ` \u00b7 ${args.name}`;
      } catch { /* The orchestrator reports malformed tool arguments separately. */ }
      const choice = await vscode.window.showWarningMessage(
        `${request.agentName} wants approval for ${target}.`,
        { modal: true, detail: request.detail ?? (request.toolName === "write_file" ? "This writes a file inside the current workspace." : "This changes persisted agent memory or project knowledge.") },
        "Allow once"
      );
      return choice === "Allow once";
    }, runWorkspaceCommand, n8n, messageBus, socket, workspaceTools, externalTools, cliAgents);
    try {
      return await orchestrator.runRoot(instruction, rootAgentId, autoRoute, {
        ...runOptions,
        approvalMode: runOptions.approvalMode || settings.get<"ask" | "approve" | "full">("approvalMode", "ask")
      });
    } finally {
      if (rootTaskId) activity.finishRoot(rootTaskId);
    }
  };

  const getComposerConfig = (agentId: string): ChatComposerConfig => {
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    const providers = cfg.get<ModelProvider[]>("providers", []);
    const agent = db.getAgent(agentId);
    const models: ChatModelOption[] = [];
    for (const provider of providers) {
      const choices = [...new Set([...(provider.models || []), provider.model].filter(Boolean))];
      for (const modelName of choices) {
        const key = `${provider.id}|${modelName}`;
        models.push({ key, label: `${provider.name} · ${modelName}`, providerId: provider.id, model: modelName });
      }
    }
    const activeProviderId = agent?.providerId || cfg.get<string>("activeProviderId", "");
    const activeProvider = providers.find(provider => provider.id === activeProviderId);
    const defaultModel = agent?.model || (agent?.providerId ? activeProvider?.model : cfg.get<string>("activeModel", "")) || activeProvider?.model || cfg.get<string>("model", "qwen3:8b");
    let selected = models.find(option => option.providerId === activeProviderId && option.model === defaultModel);
    if (!selected) {
      selected = { key: `${activeProviderId}|${defaultModel}`, label: activeProvider ? `${activeProvider.name} · ${defaultModel}` : `${defaultModel} · Settings default`, providerId: activeProviderId || undefined, model: defaultModel };
      models.unshift(selected);
    }
    return { models, selectedModelKey: selected.key, approvalMode: cfg.get<"ask" | "approve" | "full">("approvalMode", "ask") };
  };

  const pickAttachments = async () => {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Attach to agent chat"
    });
    if (!selected?.length) return [];
    const attached: Array<{ name: string; content: string }> = [];
    let totalChars = 0;
    const maxFiles = 15;
    const maxTotalChars = 120_000;
    let visited = 0;
    const addFile = async (uri: vscode.Uri, label: string, depth = 0) => {
      if (attached.length >= maxFiles || totalChars >= maxTotalChars || depth > 4 || visited++ >= 200) return;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          if (attached.length >= maxFiles) return;
          for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
            if ([".git", "node_modules", ".next", "dist", "build"].includes(name)) continue;
            const child = vscode.Uri.joinPath(uri, name);
            await addFile(child, `${label}/${name}`, depth + 1);
            if (attached.length >= maxFiles || totalChars >= maxTotalChars) break;
          }
          return;
        }
        if (!(stat.type & vscode.FileType.File) || stat.size > 64 * 1024) return;
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.some(byte => byte === 0)) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const content = text.slice(0, Math.min(40_000, maxTotalChars - totalChars));
        if (!content) return;
        attached.push({ name: label, content });
        totalChars += content.length;
      } catch { /* Skip unreadable or non-text files and continue with the rest. */ }
    };
    for (const uri of selected) {
      const name = uri.path.split("/").filter(Boolean).pop() || uri.fsPath;
      await addFile(uri, name);
      if (attached.length >= maxFiles || totalChars >= maxTotalChars) break;
    }
    if (!attached.length) vscode.window.showInformationMessage("No readable text files were attached.");
    return attached;
  };

  const sessions = new SessionRepository(db.connection);
  const discussion = new DiscussionService(model, sessions);
  const chatView = new ChatWindowProvider(queue, (instruction, agentId, selection: ChatComposerSelection, progress, conversationId, mode, intent) => {
    if (intent === "discuss") return discussion.reply(conversationId, instruction, {
      agentId,
      thinking: selection.thinking,
      supervisorDiscussion: mode === "agent" && agentId === "lead",
      agents: db.listAgents(),
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      attachments: selection.attachments,
      images: selection.images,
      onChunk: text => progress(text, { type: "chunk", agentId, text }),
      onThinking: text => progress(text, { type: "thinking_chunk", agentId, text }),
      decide: input => {
        const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
        const enabled = cfg.get<boolean>("layaEnabled", true) && cfg.get<string>("layaEndpoint", "").trim();
        return decideDiscussion(enabled ? laya : undefined, input, { automatic: cfg.get<number>("automaticExecutionConfidence", .9), enrichment: cfg.get<number>("contextEnrichmentConfidence", .65) });
      },
      onEffort: (effort, decision) => progress(`${db.getAgent(agentId)?.name ?? "Agent"} is thinking it through (${effort} effort, ${decision?.source === "laya" ? `Laya ${Math.round(decision.effort.confidence * 100)}%` : `estimated${decision?.fallbackReason ? `: ${decision.fallbackReason}` : ""}`})…`),
      onStreamReset: () => progress("", { type: "stream_reset", agentId, text: "" }),
      onConsultation: (advisorId, advice) => advice
        ? progress(advice, { type: "thinking_message", agentId: advisorId, text: advice })
        : progress(`Supervisor is consulting ${db.getAgent(advisorId)?.name ?? advisorId}…`)
    });
    const assignedPrompt = assignmentInstruction(instruction, sessions.messages(conversationId, 12).map(({ role, text }) => ({ role, text })));
    const fileContext = selection.attachments.map(file => `\n\n--- Attached file: ${file.name} ---\n${file.content}`).join("");
    const reasoning = resolveReasoning(instruction, { thinking: selection.thinking, reasoningEffort: selection.reasoningEffort, attachments: selection.attachments.length, images: selection.images.length });
    if (reasoning.estimated) progress(`Thinking it through (${reasoning.estimated} effort)…`);
    return runPrompt(assignedPrompt + fileContext, (message, event) => progress(message, event), agentId, mode === "team", {
      conversationId,
      displayPrompt: instruction,
      images: selection.images,
      attachedImageNames: selection.images.map(image => image.name),
      approvalMode: selection.approvalMode,
      planMode: selection.planMode,
      thinking: reasoning.thinking,
      reasoningEffort: reasoning.reasoningEffort,
      providerId: selection.providerId,
      model: selection.model
    });
  }, getComposerConfig, pickAttachments, messageBus, context.extensionUri, {
    sessions,
    agentName: agentId => db.getAgent(agentId)?.name,
    agents: () => db.listAgents().map(agent => ({ id: agent.id, name: agent.name })),
    remember: (agentId, scope, text, conversationId) => db.remember(agentId, scope === "all" ? "project" : "private", text, "semantic", conversationId),
    layaStatus: () => {
      const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
      return cfg.get<boolean>("layaEnabled", true) && cfg.get<string>("layaEndpoint", "").trim() ? laya.status : undefined;
    }
  });
  context.subscriptions.push(chatView);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatView));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("agentOrchestrator.robotModel")) chatView.reloadRobotModel();
  }));
  const workbench = new Workbench(context, db, activity, {
    layaEnabled: () => vscode.workspace.getConfiguration("agentOrchestrator").get<boolean>("layaEnabled", true),
    layaEndpoint: () => vscode.workspace.getConfiguration("agentOrchestrator").get<string>("layaEndpoint", ""),
    layaStatus: () => laya.status,
    workspaces: () => (vscode.workspace.workspaceFolders ?? []).map(folder => ({ key: folder.uri.toString(), name: folder.name }))
  }, agentId => {
    if (agentId === "team") { chatView.openTeamChat(); return; }
    const agent = db.getAgent(agentId);
    if (agent) chatView.openAgent(agent.id, agent.name);
  }, conversationId => chatView.openSession(conversationId));
  context.subscriptions.push(workbench);
  // Laya loads its model on the first request (10-20 s). Warm it up in the background so the first
  // chat gets a fast answer instead of a timeout; do it again when the Laya settings change.
  const warmUpLaya = () => {
    if (!vscode.workspace.getConfiguration("agentOrchestrator").get<boolean>("layaEnabled", true)) return;
    void laya.warmUp().finally(() => { workbench.notify(["health"]); chatView.refreshLayaStatus(); });
  };
  warmUpLaya();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("agentOrchestrator.robotModel")) chatView.reloadRobot();
    if (["layaEnabled", "layaEndpoint", "layaModel", "layaKeepAlive"].some(key => event.affectsConfiguration(`agentOrchestrator.${key}`))) warmUpLaya();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.chatWithAgent", async (agentId: string) => {
    if (agentId === "team") { chatView.openTeamChat(); return; }
    const agent = db.getAgent(agentId);
    if (!agent) return;
    chatView.openAgent(agent.id, agent.name);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.openAgentChat", () => chatView.openTeamChat()));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.showExternalTools", () => showExternalTools(externalTools)));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.openSettings", async () => {
    await vscode.commands.executeCommand("workbench.action.openSettings", "agentOrchestrator");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.configureProviderKey", async () => {
    const providers = vscode.workspace.getConfiguration("agentOrchestrator").get<ModelProvider[]>("providers", []);
    const selected = await vscode.window.showQuickPick(providers.map(provider => ({ label: provider.name, description: provider.id, provider })), { title: "Choose provider for API key" });
    if (!selected) return;
    const apiKey = await vscode.window.showInputBox({ title: `API key \u00b7 ${selected.provider.name}`, prompt: "Stored securely in VS Code Secret Storage.", password: true, ignoreFocusOut: true });
    if (apiKey === undefined) return;
    if (apiKey) await context.secrets.store(`agentOrchestrator.provider.${selected.provider.id}.apiKey`, apiKey);
    else await context.secrets.delete(`agentOrchestrator.provider.${selected.provider.id}.apiKey`);
    vscode.window.showInformationMessage(apiKey ? `Saved API key for ${selected.provider.name}.` : `Removed the saved API key for ${selected.provider.name}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.configureN8nToken", async () => {
    const links = vscode.workspace.getConfiguration("agentOrchestrator").get<N8nAgentLink[]>("n8nLinks", []);
    const selected = await vscode.window.showQuickPick(links.map(link => ({ label: link.name, description: link.id, link })), { title: "Choose n8n connection" });
    if (!selected) return;
    const token = await vscode.window.showInputBox({ title: `n8n token \u00b7 ${selected.link.name}`, prompt: "Stored securely in VS Code Secret Storage. Leave empty to remove it.", password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    if (token) await context.secrets.store(`agentOrchestrator.n8n.${selected.link.id}.token`, token);
    else await context.secrets.delete(`agentOrchestrator.n8n.${selected.link.id}.token`);
    vscode.window.showInformationMessage(token ? `Saved token for ${selected.link.name}.` : `Removed the token for ${selected.link.name}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.configureSocketToken", async () => {
    const links = vscode.workspace.getConfiguration("agentOrchestrator").get<SocketAgentLink[]>("socketLinks", []);
    const selected = await vscode.window.showQuickPick(links.map(link => ({ label: link.name, description: link.id, link })), { title: "Choose socket connection" });
    if (!selected) return;
    const token = await vscode.window.showInputBox({ title: `Socket token \u00b7 ${selected.link.name}`, prompt: "Stored securely in VS Code Secret Storage. Leave empty to remove it.", password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    if (token) await context.secrets.store(`agentOrchestrator.socket.${selected.link.id}.token`, token);
    else await context.secrets.delete(`agentOrchestrator.socket.${selected.link.id}.token`);
    vscode.window.showInformationMessage(token ? `Saved token for ${selected.link.name}.` : `Removed the token for ${selected.link.name}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.configureLayaKey", async () => {
    const hasKey = Boolean(await context.secrets.get("agentOrchestrator.laya.apiKey"));
    const key = await vscode.window.showInputBox({
      title: "Laya API key",
      prompt: `${hasKey ? "A key is already saved. Enter a new one to replace it, or leave empty to remove it." : "Leave empty to use Laya without a key."} It is sent as an Authorization Bearer token and kept in VS Code Secret Storage.`,
      placeHolder: hasKey ? "•••••••• (saved)" : "Paste your Laya API key",
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) return;
    const trimmed = key.trim();
    if (trimmed) await context.secrets.store("agentOrchestrator.laya.apiKey", trimmed);
    else await context.secrets.delete("agentOrchestrator.laya.apiKey");
    if (!trimmed && !hasKey) return;
    // Check the new key right away when an endpoint is set; a successful call also clears the 30 s back-off.
    if (vscode.workspace.getConfiguration("agentOrchestrator").get<string>("layaEndpoint", "").trim()) {
      await vscode.commands.executeCommand("agentOrchestrator.testLaya", trimmed ? "Saved the Laya API key." : "Removed the Laya API key.");
    } else {
      const choice = await vscode.window.showInformationMessage(`${trimmed ? "Saved" : "Removed"} the Laya API key. Set the Laya endpoint to start using it.`, "Open Laya Settings");
      if (choice) await vscode.commands.executeCommand("workbench.action.openSettings", "agentOrchestrator.laya");
    }
  }));

  // While Laya is paused, send one small request every layaRetryMinutes (0 = manual only). Chats never wait on it;
  // if Laya answers it resumes, otherwise it stays paused and the next check waits another interval.
  let lastLayaCheck = 0;
  let checkingLaya = false;
  const layaRetryTimer = setInterval(() => {
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    if (checkingLaya || !cfg.get<boolean>("layaEnabled", true) || !cfg.get<string>("layaEndpoint", "").trim()) return;
    if (!shouldRetryLaya(laya.status, lastLayaCheck, cfg.get<number>("layaRetryMinutes", 5))) return;
    checkingLaya = true;
    lastLayaCheck = Date.now();
    void laya.warmUp().finally(() => { checkingLaya = false; workbench.notify(["health"]); chatView.refreshLayaStatus(); });
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(layaRetryTimer) });

  // Laya pauses itself after a failed request; this resumes it without a test, so the next chat calls it again.
  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.resumeLaya", () => {
    laya.resume();
    workbench.notify(["health"]);
    chatView.refreshLayaStatus();
    void vscode.window.showInformationMessage("Laya resumed. The next decision will call it again.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.testLaya", async (prefix?: unknown) => {
    const lead = typeof prefix === "string" ? `${prefix} ` : "";
    try {
      // Send the same routing request a chat starts with, so the test catches slow answers too.
      // The lead agent goes first: ping() treats the first agent as the root, like a chat does.
      const agents = db.listAgents();
      const { latencyMs, coldStartMs } = await laya.ping([...agents.filter(agent => agent.id === "lead"), ...agents.filter(agent => agent.id !== "lead")]);
      const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
      const model = cfg.get<string>("layaModel", "").trim();
      const timeoutMs = cfg.get<number>("layaTimeoutMs", 5000);
      const tight = latencyMs > timeoutMs * .7;
      const coldNote = coldStartMs ? ` The first request took ${(coldStartMs / 1000).toFixed(1)} s while the model loaded.` : "";
      const message = `${lead}Laya answered${model ? ` (${model})` : ""} in ${(latencyMs / 1000).toFixed(1)} s${tight ? `, close to the ${(timeoutMs / 1000).toFixed(1)} s timeout. Chats may fall back when it is slower.` : "."}${coldNote}`;
      const choice = tight ? await vscode.window.showWarningMessage(message, "Increase Timeout") : await vscode.window.showInformationMessage(message);
      if (choice === "Increase Timeout") await vscode.commands.executeCommand("workbench.action.openSettings", "agentOrchestrator.layaTimeoutMs");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedKey = /HTTP (401|403)\b/.test(message);
      const timedOut = /timed out/.test(message);
      const choice = await vscode.window.showWarningMessage(
        `${lead}${rejectedKey ? "Laya rejected the API key" : timedOut ? "Laya answered too slowly" : "Laya is unavailable"}; Laya stays paused and decisions use the fallback until a test succeeds. ${message}`,
        ...(rejectedKey ? ["Set API Key", "Open Laya Settings"] : timedOut ? ["Increase Timeout", "Open Laya Settings"] : ["Open Laya Settings", "Set API Key"])
      );
      if (choice === "Increase Timeout") await vscode.commands.executeCommand("workbench.action.openSettings", "agentOrchestrator.layaTimeoutMs");
      else if (choice === "Set API Key") await vscode.commands.executeCommand("agentOrchestrator.configureLayaKey");
      else if (choice === "Open Laya Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "agentOrchestrator.laya");
    } finally {
      workbench.notify(["health"]);
      chatView.refreshLayaStatus();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("agentOrchestrator.manageAgents", async () => {
    const agents = db.listAgents();
    const selected = await vscode.window.showQuickPick([
      { label: "$(add) Create agent", id: "__new" },
      ...agents.map(agent => ({ label: agent.name, description: `${agent.id} \u00b7 ${agent.skills.join(", ")}`, id: agent.id }))
    ], { title: "Manage agents" });
    if (!selected) return;
    let current = selected.id === "__new" ? undefined : db.getAgent(selected.id);
    if (current) {
      const action = await vscode.window.showQuickPick(["Edit agent", ...(current.id === "lead" ? [] : ["Delete agent"])], { title: current.name });
      if (!action) return;
      if (action === "Delete agent") {
        const confirm = await vscode.window.showWarningMessage(`Delete agent '${current.name}'?`, { modal: true }, "Delete");
        if (confirm === "Delete") { db.deleteAgent(current.id); workbench.notify(["agents"]); }
        return;
      }
    }
    const name = await vscode.window.showInputBox({ title: "Agent name", value: current?.name || "", ignoreFocusOut: true });
    if (!name?.trim()) return;
    const id = current?.id || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const description = await vscode.window.showInputBox({ title: "Agent description", value: current?.description || "", ignoreFocusOut: true });
    if (description === undefined) return;
    const skills = await vscode.window.showInputBox({ title: "Skills (comma-separated)", value: current?.skills.join(", ") || "", ignoreFocusOut: true });
    if (skills === undefined) return;
    const systemPrompt = await vscode.window.showInputBox({ title: "System prompt", value: current?.systemPrompt || "You are a helpful specialist agent.", ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : "A system prompt is required." });
    if (!systemPrompt) return;
    const policyPick = await vscode.window.showQuickPick([
      { label: "General", description: "Balanced fallback policy", id: "general" },
      { label: "Coder", description: "Workspace implementation and code review", id: "coder" },
      { label: "Researcher", description: "Evidence, memory, and knowledge graph retrieval", id: "researcher" },
      { label: "Planner", description: "Plans, task structure, and agent coordination", id: "planner" }
    ], { title: "Agent Laya policy", placeHolder: current?.layaProfile || "Choose the questions and tool categories for this agent" });
    if (!policyPick) return;
    const cfg = vscode.workspace.getConfiguration("agentOrchestrator");
    const providers = cfg.get<ModelProvider[]>("providers", []);
    const providerPick = await vscode.window.showQuickPick([
      { label: "Use default provider", id: "" },
      ...providers.map(provider => ({ label: provider.name, description: provider.id, id: provider.id }))
    ], { title: "Provider for this agent" });
    if (!providerPick) return;
    const provider = providers.find(item => item.id === providerPick.id);
    const model = provider ? await vscode.window.showInputBox({ title: "Model for this agent (optional)", value: current?.model || provider.model || "", ignoreFocusOut: true }) : current?.model || "";
    if (model === undefined) return;
    const links = cfg.get<N8nAgentLink[]>("n8nLinks", []);
    const socketLinks = cfg.get<SocketAgentLink[]>("socketLinks", []);
    const transportPick = await vscode.window.showQuickPick([
      { label: "Run in this extension", id: "" },
      ...links.map(link => ({ label: `n8n \u00b7 ${link.name}`, description: link.webhookUrl, id: `n8n:${link.id}` })),
      ...socketLinks.map(link => ({ label: `WebSocket \u00b7 ${link.name}`, description: link.url, id: `socket:${link.id}` })),
      ...cliLinks().map(link => ({ label: `CLI \u00b7 ${link.name}`, description: `${link.preset ?? "custom"} \u00b7 runs with its own tools and permissions`, id: `cli:${link.id}` }))
    ], { title: "Agent runtime" });
    if (!transportPick) return;
    const canDelegate = await vscode.window.showQuickPick(["Can ask/delegate to other agents", "Do not delegate"], { title: "Agent permissions" });
    if (!canDelegate) return;
    const agent: AgentDefinition = {
      ...(current || { status: "idle" as const, layaProfile: "general" }),
      id, name: name.trim(), description, systemPrompt,
      skills: skills.split(",").map(skill => skill.trim()).filter(Boolean),
      providerId: providerPick.id || undefined,
      model: model.trim() || undefined,
      n8nLinkId: transportPick.id.startsWith("n8n:") ? transportPick.id.slice(4) : undefined,
      socketLinkId: transportPick.id.startsWith("socket:") ? transportPick.id.slice(7) : undefined,
      cliLinkId: transportPick.id.startsWith("cli:") ? transportPick.id.slice(4) : undefined,
      layaProfile: policyPick.id,
      canDelegate: canDelegate.startsWith("Can")
    };
    db.upsertAgent(agent); workbench.notify(["agents"]);
    vscode.window.showInformationMessage(`Saved agent ${agent.name}.`);
  }));

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

      try {
        response.progress("$(sync~spin) Queued with the agent team...");
        const result = await queue.enqueue(instruction.slice(0, 80), () => runPrompt(instruction, (_message, event) => {
          if (!event || token.isCancellationRequested) return;
          if (event.type === "delegate") response.progress(`$(organization) ${event.text}`);
          else if (event.type === "start" && event.agentId !== "lead") response.progress(`$(sync~spin) ${event.agentId} is working...`);
        }));
        if (!token.isCancellationRequested) response.markdown(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.markdown(`$(error) **Agent task failed:** ${message}`);
      }
    }
  );
  // Fixed-colour variants: tab and chat icons are drawn as images, where currentColor would be black.
  participant.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, "media", "agents-light.svg"), dark: vscode.Uri.joinPath(context.extensionUri, "media", "agents-dark.svg") };
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
