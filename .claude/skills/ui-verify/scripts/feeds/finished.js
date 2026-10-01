// A finished Codex-style reply: "Worked for Ns ›" folds the steps (click it to expand), answer text, edited-files card.
// Add --hash open to show the expanded steps.
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "user", text: "Add input validation to the signup form" }, 200);
send({ type: "session-meta", id: "s1", title: "Add input validation to the signup form", archived: false }, 220);
send({ type: "activity", event: { type: "start", agentId: "coder", text: "" } }, 300);
[["read_file", "src/auth/SignupForm.tsx"], ["search_workspace", ""], ["write_file", "src/auth/SignupForm.tsx"], ["write_file", "src/auth/validation.ts"], ["run_command", ""]].forEach(([tool, path], i) => {
  send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: tool, toolCallId: "c" + i, phase: "start", path } }, 340 + i * 30);
  send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: tool, toolCallId: "c" + i, phase: "complete", path, text: "{}" } }, 350 + i * 30);
});
send({ type: "result", text: "Added validation for **email** and **password** in `SignupForm.tsx`, with the rules in `validation.ts`.\n\n- Email must be a valid address.\n- Password needs 8+ characters.\n\nRun `bun test` to check it." }, 600);
setTimeout(() => {
  if (location.hash === "#open") document.querySelector(".response-head").click();
  setTimeout(() => {
    document.documentElement.dataset.debug = "head=" + document.querySelector(".response-elapsed").textContent.replace(/\d+/, "N") + " stepsVisible=" + Boolean(document.querySelector(".response-activity")?.offsetParent)
      + " summary=" + document.querySelector(".activity-summary > span")?.textContent + " files=" + document.querySelectorAll(".response-file").length;
  }, 200);
}, 900);
