// History rail + an opened chat with markdown (code block, inline code, quote). Add #hover to show the message toolbar.
const now = Date.now(), ago = ms => new Date(now - ms).toISOString(), H = 3600e3, D = 24 * H;
setTimeout(() => {
  window.postMessage({ type: "sessions", currentId: "s1", recent: [
    { id: "s1", title: "How do I deploy this project?", agentName: "DevOps", updatedAt: ago(30e3), turns: 3 },
    { id: "s2", title: "Hello", agentName: "Lead", updatedAt: ago(30 * 60e3), turns: 3 },
    { id: "s3", title: "Check this project description", agentName: "Lead", updatedAt: ago(33 * 60e3), turns: 2 },
    { id: "s4", title: "continue", agentName: "Coder", updatedAt: ago(26 * H), turns: 1 },
    { id: "s5", title: "Research LLM options for the gateway", agentName: "Researcher", updatedAt: ago(4 * D), turns: 2 }],
    archived: [{ id: "a1", title: "Old experiment", agentName: "Coder", updatedAt: ago(40 * D), archived: true, turns: 2 }] }, "*");
  window.postMessage({ type: "session", id: "s1", title: "How do I deploy this project?", archived: false, messages: [
    { role: "user", text: "How do I deploy this project?" },
    { role: "result", author: "DevOps", text: "It's a VS Code extension, so you **package and install** it:\n\n```bash\nbun run package\ncode --install-extension agent-orchestrator-0.1.0.vsix --force\n```\n\nThe model endpoint comes from `agentOrchestrator.baseUrl`.\n\n> Reload the window after installing." },
    { role: "user", text: "What about the desktop app?" }] }, "*");
}, 300);
if (location.hash === "#hover") setTimeout(() => document.querySelectorAll(".message-actions").forEach(bar => { bar.style.transition = "none"; bar.style.opacity = "1"; }), 700);
