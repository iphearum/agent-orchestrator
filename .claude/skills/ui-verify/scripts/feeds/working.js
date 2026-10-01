// Freezes a run mid-way: a pasted image, the user message, then reads, a delegation, one edit and a read still running.
// Shows the live reply: "Working for Ns" line, open step list with icons, loading placeholder, edited-files card.
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="110"><rect width="160" height="110" fill="#e8eef8"/><rect x="14" y="14" width="132" height="16" rx="4" fill="#9db5dc"/><rect x="14" y="40" width="90" height="10" rx="3" fill="#c3d2ea"/><rect x="14" y="58" width="110" height="10" rx="3" fill="#c3d2ea"/></svg>');
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "attachments", files: [{ id: "img1", name: "design.png", image: true, dataUrl: image }] }, 150);
send({ type: "user", text: "Make the login form match this design", images: [{ id: "img1", name: "design.png" }] }, 200);
send({ type: "session-meta", id: "s1", title: "Make the login form match this design", archived: false }, 220);
send({ type: "activity", event: { type: "start", agentId: "lead", text: "hi" } }, 300);
send({ type: "activity", event: { type: "tool", agentId: "lead", toolName: "search_workspace", toolCallId: "c1", phase: "start", text: "" } }, 340);
send({ type: "activity", event: { type: "tool", agentId: "lead", toolName: "search_workspace", toolCallId: "c1", phase: "complete", text: "{}" } }, 380);
send({ type: "activity", event: { type: "delegate", agentId: "lead", text: "delegate -> Coder: update the login form" } }, 420);
send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: "read_file", toolCallId: "c2", phase: "start", path: "src/auth/login.ts" } }, 460);
send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: "read_file", toolCallId: "c2", phase: "complete", path: "src/auth/login.ts", text: "{}" } }, 480);
send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: "write_file", toolCallId: "c3", phase: "start", path: "src/auth/LoginForm.tsx" } }, 500);
send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: "write_file", toolCallId: "c3", phase: "complete", path: "src/auth/LoginForm.tsx", text: "{}" } }, 520);
send({ type: "activity", event: { type: "tool", agentId: "coder", toolName: "read_file", toolCallId: "c4", phase: "start", path: "src/auth/login.css" } }, 560);
setTimeout(() => {
  const pending = document.querySelectorAll(".message.response.pending").length;
  const visibleSteps = [...document.querySelectorAll(".response-activity-item")].filter(row => row.offsetParent).length;
  document.documentElement.dataset.debug = "pending=" + pending + " visibleSteps=" + visibleSteps + " head=" + (document.querySelector(".response-elapsed")?.textContent.replace(/\d+/, "N") || "none")
    + " files=" + document.querySelectorAll(".response-file").length + " images=" + document.querySelectorAll(".user-images img").length;
}, 3200);
