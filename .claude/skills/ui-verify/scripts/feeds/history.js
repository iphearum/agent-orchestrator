// A reopened chat: an old answer without a saved record, a saved reply (steps, thinking, edited file) and a failed one.
// Checks: saved replies rebuild as finished ("Worked for 1m 05s ›", "Stopped after 4s ›"), steps fold, the file card returns.
const tool = (id, toolName, path) => [
  { type: "tool", agentId: "coder", toolName, toolCallId: id, phase: "start", path },
  { type: "tool", agentId: "coder", toolName, toolCallId: id, phase: "complete", path }
];
const at = new Date().toISOString();
setTimeout(() => {
  window.postMessage({ type: "session", id: "s1", title: "Signup validation", archived: false, messages: [
    { role: "user", text: "What does this project do?", at },
    { role: "result", text: "An older answer saved before reply records existed.", author: "Lead", at },
    { role: "user", text: "Add input validation to the signup form", at },
    { role: "result", author: "Coder", at, text: "Added validation in `SignupForm.tsx` and `validation.ts`.", trace: { version: 1, durationMs: 65000,
      steps: [{ type: "start", agentId: "coder" }, ...tool("c1", "read_file", "src/auth/SignupForm.tsx"),
        { type: "tool", agentId: "coder", toolName: "ask_agent", toolCallId: "a1", phase: "start" },
        { type: "delegate", agentId: "coder", targetAgentId: "researcher", delegateMode: "ask", text: "ask -> Researcher: Consultation request from Coder:\nWhich validation library does the project use?" },
        { type: "tool", agentId: "coder", toolName: "ask_agent", toolCallId: "a1", phase: "complete", text: JSON.stringify({ result: "It uses **zod**." }) },
        ...tool("c2", "write_file", "src/auth/validation.ts")],
      thinking: [{ agentId: "coder", text: "Check the existing form before adding rules." }] } },
    { role: "user", text: "Run the tests", at },
    { role: "result", author: "Coder", at, text: "Can't reach the configured model provider.", trace: { version: 1, durationMs: 4000, failed: true, steps: [{ type: "start", agentId: "coder" }], thinking: [] } }
  ] }, "*");
  // Headless Chrome under --virtual-time-budget does not advance CSS transitions, so switch them off to see the end state.
  if (location.hash === "#open") {
    document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{transition:none!important}</style>");
    setTimeout(() => document.querySelectorAll(".response-head")[0]?.click(), 100);
  }
}, 300);
setTimeout(() => {
  const heads = [...document.querySelectorAll(".response-elapsed")].map(el => el.textContent);
  document.documentElement.dataset.debug = "replies=" + document.querySelectorAll("article.message.response").length + " heads=" + heads.join("|")
    + " pending=" + document.querySelectorAll(".message.response.pending").length + " files=" + document.querySelectorAll(".response-file").length
    + " failed=" + document.querySelectorAll(".message.response.error").length
    + " handoffs=" + [...document.querySelectorAll(".delegate-group .delegate-head .activity-label")].map(label => label.textContent).join("|") + " answers=" + document.querySelectorAll(".delegate-answer").length
    + (location.hash === "#open" ? " open=" + document.querySelectorAll(".message.response.process-open").length + " chevron=" + getComputedStyle(document.querySelector(".process-open .response-elapsed") || document.body, "::after").transform : "");
}, 900);
