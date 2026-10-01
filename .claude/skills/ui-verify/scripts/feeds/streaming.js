// A reply still streaming: Markdown arrives in small chunks and stops inside an unclosed ```json fence.
// Checks: headings, list, bold, inline code and the open code block are rendered while streaming (no raw ## or ```).
// Entrance animations do not advance reliably under --virtual-time-budget while frames are busy; show the end state.
document.head.insertAdjacentHTML("beforeend", "<style>.message,.message *{animation:none!important}</style>");
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
const text = "## Running Agents\n\n### Local Models\n\n- Open the folder in VS Code and press `F5` to launch the extension.\n- For a quick compile, run **`npm run compile`**.\n\n### MCP Servers as Tools\n\nAssign one CLI agent to an agent:\n\n```json\n{\n  \"agentOrchestrator.cliAgents\": [\n    { \"id\": \"codex\", \"preset\": \"codex\" }\n";
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "user", text: "Write me a document for that." }, 200);
send({ type: "activity", event: { type: "start", agentId: "documenter", text: "" } }, 250);
for (let i = 0; i < text.length; i += 12) send({ type: "chunk", text: text.slice(i, i + 12) }, 300 + i * 2);
setTimeout(() => {
  const content = document.querySelector(".message.response.pending .message-content");
  const raw = content?.textContent || "";
  document.documentElement.dataset.debug = "h2=" + content.querySelectorAll("h2").length + " h3=" + content.querySelectorAll("h3").length + " li=" + content.querySelectorAll("li").length
    + " strong=" + content.querySelectorAll("strong").length + " pre=" + content.querySelectorAll("pre").length + " rawMarks=" + /(^|\n)#{2,3} |```/.test(raw);
}, 2500);
