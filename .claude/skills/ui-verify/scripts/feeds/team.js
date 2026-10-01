// Lead runs a team with delegate_team: Researcher, Coder and DevOps in parallel, then Reviewer after them.
// Mirrors Orchestrator.runTeam's events: each member's hand-off has its own toolCallId ("team:…"), closed by a
// delegate_task tool event. Default: the three members done, Reviewer working. --hash done: the reply finishes.
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
const act = (event, delay) => send({ type: "activity", event }, delay);
const done = location.hash === "#done";
document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>");
const member = (id, name, text) => ({ type: "delegate", agentId: "lead", targetAgentId: id, delegateMode: "delegate", toolCallId: `team:${id}`, text: `delegate -> ${name}: ${text}` });
const finish = (id, result, failed) => ({ type: "tool", agentId: "lead", toolName: "delegate_task", toolCallId: `team:${id}`, phase: failed ? "error" : "complete", text: JSON.stringify(failed ? { error: result } : { result }) });
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "user", text: "Fix authentication 500 error" }, 200);
act({ type: "start", agentId: "lead", text: "" }, 250);
act({ type: "tool", agentId: "lead", toolName: "delegate_team", toolCallId: "t1", phase: "start" }, 300);
act(member("researcher", "Researcher", "Check related changes"), 320);
act(member("coder", "Coder", "Inspect and fix the login code"), 330);
act(member("devops", "DevOps", "Check the environment and migrations"), 340);
act({ type: "start", agentId: "researcher", text: "" }, 350);
act({ type: "start", agentId: "coder", text: "" }, 355);
act({ type: "start", agentId: "devops", text: "" }, 360);
act({ type: "tool", agentId: "researcher", toolName: "search_workspace", toolCallId: "r1", phase: "start" }, 370);
act({ type: "tool", agentId: "coder", toolName: "read_file", toolCallId: "c1", phase: "start", path: "src/auth/login.py" }, 375);
act({ type: "tool", agentId: "coder", toolName: "ask_agent", toolCallId: "c2", phase: "start" }, 378);
act({ type: "delegate", agentId: "coder", targetAgentId: "database", delegateMode: "ask", text: "ask -> Database: Consultation request from Coder:\nIs users.email nullable after the migration?" }, 380);
act({ type: "start", agentId: "database", text: "" }, 385);
act({ type: "tool", agentId: "researcher", toolName: "search_workspace", toolCallId: "r1", phase: "complete", text: "{}" }, 400);
act({ type: "tool", agentId: "coder", toolName: "read_file", toolCallId: "c1", phase: "complete", path: "src/auth/login.py", text: "{}" }, 405);
act({ type: "tool", agentId: "coder", toolName: "ask_agent", toolCallId: "c2", phase: "complete", text: JSON.stringify({ ok: true, agent: "database", mode: "ask", result: "Yes, since migration 0042." }) }, 410);
act(finish("researcher", "Commit a3f9c2 made `users.email` nullable."), 420);
act(finish("coder", "Added a null check in `login.py` and a test."), 430);
act(finish("devops", "model timed out", true), 440);
act(member("reviewer", "Reviewer", "Review the changes"), 450);
act({ type: "start", agentId: "reviewer", text: "" }, 455);
if (done) {
  act(finish("reviewer", "Looks good; log the missing-user case."), 500);
  act({ type: "tool", agentId: "lead", toolName: "delegate_team", toolCallId: "t1", phase: "complete", text: "{}" }, 520);
  send({ type: "result", text: "Fixed: `login.py` now handles a missing user, with a test. DevOps could not check the environment." }, 600);
  setTimeout(() => { document.querySelector(".response-head")?.click(); document.querySelector(".response-activity").open = true; }, 800);
}
setTimeout(() => {
  const groups = [...document.querySelectorAll(".delegate-group")];
  document.documentElement.dataset.debug = "groups=" + groups.length + " nested=" + document.querySelectorAll(".delegate-steps .delegate-group").length
    + " working=" + document.querySelectorAll(".delegate-group.working").length + " failed=" + document.querySelectorAll(".delegate-group.failed").length
    + " labels=" + groups.map(group => group.querySelector(".delegate-head .activity-label").textContent).join("|");
}, 1200);
