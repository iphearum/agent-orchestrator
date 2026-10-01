// Lead delegates to Planner, who reads a file, thinks, and asks Researcher (a nested hand-off).
// Default: mid-run (groups working, header "waiting for …"). --hash done: answers arrive and the reply finishes.
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
const act = (event, delay) => send({ type: "activity", event }, delay);
const done = location.hash === "#done";
document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>");
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "user", text: "Hey lead, help me write the setup guide" }, 200);
act({ type: "start", agentId: "lead", text: "" }, 250);
act({ type: "tool", agentId: "lead", toolName: "delegate_task", toolCallId: "d1", phase: "start" }, 300);
act({ type: "delegate", agentId: "lead", targetAgentId: "planner", delegateMode: "delegate", text: "delegate -> Planner: Outline the setup guide: prerequisites, install, configuration, first run." }, 320);
act({ type: "start", agentId: "planner", text: "" }, 340);
send({ type: "thinking_chunk", agentId: "planner", text: "Start from the README and package.json scripts." }, 360);
act({ type: "tool", agentId: "planner", toolName: "read_file", toolCallId: "p1", phase: "start", path: "README.md" }, 380);
act({ type: "tool", agentId: "planner", toolName: "read_file", toolCallId: "p1", phase: "complete", path: "README.md", text: "{}" }, 400);
act({ type: "tool", agentId: "planner", toolName: "ask_agent", toolCallId: "p2", phase: "start" }, 420);
act({ type: "delegate", agentId: "planner", targetAgentId: "researcher", delegateMode: "ask", text: "ask -> Researcher: Consultation request from Planner:\nWhich Node version does the extension need?" }, 440);
act({ type: "start", agentId: "researcher", text: "" }, 460);
act({ type: "tool", agentId: "researcher", toolName: "search_workspace", toolCallId: "r1", phase: "start" }, 480);
if (done) {
  act({ type: "tool", agentId: "researcher", toolName: "search_workspace", toolCallId: "r1", phase: "complete", text: "{}" }, 500);
  act({ type: "tool", agentId: "planner", toolName: "ask_agent", toolCallId: "p2", phase: "complete", text: JSON.stringify({ ok: true, agent: "researcher", mode: "ask", result: "Node **22.5+** (it uses `node:sqlite`)." }) }, 520);
  act({ type: "tool", agentId: "lead", toolName: "delegate_task", toolCallId: "d1", phase: "complete", text: JSON.stringify({ ok: true, agent: "planner", mode: "delegate", result: "1. Prerequisites\n2. Install\n3. Configure providers\n4. First run" }) }, 540);
  send({ type: "result", text: "Here is the setup guide outline, based on Planner's plan." }, 600);
  // Expand the finished reply and the answers so the screenshot shows them.
  setTimeout(() => { document.querySelector(".response-head")?.click(); document.querySelector(".response-activity").open = true; document.querySelectorAll(".delegate-answer").forEach(item => { item.open = true; }); }, 800);
}
setTimeout(() => {
  const groups = [...document.querySelectorAll(".delegate-group")];
  document.documentElement.dataset.debug = "groups=" + groups.length + " nested=" + document.querySelectorAll(".delegate-steps .delegate-group").length
    + " labels=" + groups.map(group => group.querySelector(".delegate-head .activity-label").textContent).join("|")
    + " head=" + document.querySelector(".response-elapsed")?.textContent.replace(/\d+s/, "Ns") + " answers=" + document.querySelectorAll(".delegate-answer").length
    + " loose=" + document.querySelectorAll(".response-activity-list > .response-activity-item:not(.delegate-group)").length + " bubbles=" + document.querySelectorAll("article.agent-message").length;
}, 1200);
