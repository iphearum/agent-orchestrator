// The home screen with chat history: recent chats (top 5) with short ages and "View all (N)".
// Add --hash history to open the full chat history page.
const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
const recent = [
  ["Test Laya decision service", 18], ["Create AGENTS.md and progress docs", 20], ["Analyze extension spec and UI", 26],
  ["Fix login form validation", 50], ["Plan the release checklist", 75], ["Explain the orchestrator pipeline", 170], ["Hello", 400]
].map(([title, hours], i) => ({ id: "s" + i, title, agentName: "Lead", turns: 2 + i, updatedAt: hoursAgo(hours) }));
setTimeout(() => {
  window.postMessage({ type: "sessions", currentId: null, recent, archived: [] }, "*");
  window.postMessage({ type: "session", id: null, title: null, archived: false, messages: [] }, "*");
  // Headless Chrome under --virtual-time-budget does not advance CSS transitions; switch them off to see the open dropdown.
  if (location.hash === "#history") {
    document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{transition:none!important}</style>");
    setTimeout(() => document.querySelector("#toggle-sessions").click(), 100);
  }
}, 300);
setTimeout(() => {
  document.documentElement.dataset.debug = "recentRows=" + document.querySelectorAll(".home-recent").length + " viewAll=" + document.querySelector("#home-view-all").textContent + " historyOpen=" + document.querySelector("#shell").classList.contains("history-open");
}, 900);
