// Laya paused after a timeout: the slim status line under the header with a Resume button.
// Checks: the line shows while paused, hides again when the host reports Laya resumed (--hash resumed).
const at = new Date(Date.now() - 12 * 60_000).toISOString();
setTimeout(() => {
  window.postMessage({ type: "sessions", currentId: null, recent: [], archived: [] }, "*");
  window.postMessage({ type: "session", id: null, title: null, archived: false, messages: [] }, "*");
  window.postMessage({ type: "laya-status", paused: true, pausedAt: at, reason: "Laya request timed out after 5000ms." }, "*");
  if (location.hash === "#resumed") setTimeout(() => window.postMessage({ type: "laya-status", paused: false }, "*"), 100);
}, 300);
setTimeout(() => {
  const line = document.querySelector("#laya-line");
  document.documentElement.dataset.debug = "shown=" + !line.hidden + " text=" + document.querySelector("#laya-line-text").textContent.replace(/\d{1,2}:\d{2}(\s?[AP]M)?/, "HH:MM") + " title=" + line.title;
}, 900);
