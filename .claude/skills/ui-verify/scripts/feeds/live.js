// Replays the host messages of one real run: user message, agent start, a tool call, repeated reads, result, toast.
// Checks: exactly two bubbles, no stray empty agent bubbles, finished rows closed ("… finished"), repeated rows collapsed (×N).
const send = (message, delay) => setTimeout(() => window.postMessage(message, "*"), delay);
const read = (id, delay) => {
  send({ type: "activity", event: { type: "tool", agentId: "devops", toolName: "read_file", toolCallId: id, phase: "start", path: "backend/src/persistence/database.ts" } }, delay);
  send({ type: "activity", event: { type: "tool", agentId: "devops", toolName: "read_file", toolCallId: id, phase: "complete", path: "backend/src/persistence/database.ts", text: "{}" } }, delay + 10);
};
send({ type: "session", id: null, title: null, archived: false, messages: [] }, 100);
send({ type: "user", text: "How do I deploy this project?" }, 200);
send({ type: "session-meta", id: "s1", title: "How do I deploy this project?", archived: false }, 220);
send({ type: "sessions", currentId: "s1", recent: [{ id: "s1", title: "How do I deploy this project?", agentName: "DevOps", updatedAt: new Date().toISOString(), turns: 1 }], archived: [] }, 240);
send({ type: "activity", event: { type: "start", agentId: "devops", text: "How do I deploy this project?" } }, 300);
read("c1", 340); read("c2", 380); read("c3", 420);
send({ type: "result", text: "Package it with `bun run package`, then install the VSIX with `code --install-extension`." }, 500);
send({ type: "sessions", currentId: "s1", recent: [{ id: "s1", title: "How do I deploy this project?", agentName: "DevOps", updatedAt: new Date().toISOString(), turns: 1 }], archived: [] }, 520);
send({ type: "toast", text: "Copied." }, 560);
setTimeout(() => { document.documentElement.dataset.debug = "messages=" + document.querySelectorAll("#messages > article").length + " working=" + document.querySelectorAll(".response-activity-item.working,.response-activity-item.progress").length + " collapsed=" + (document.querySelector(".activity-count")?.textContent || "none"); }, 900);
