// A brand-new chat: welcome state, no archive button, empty history.
setTimeout(() => {
  window.postMessage({ type: "sessions", currentId: null, recent: [], archived: [] }, "*");
  window.postMessage({ type: "session", id: null, title: null, archived: false, messages: [] }, "*");
}, 300);
setTimeout(() => { document.documentElement.dataset.debug = "archiveHidden=" + getComputedStyle(document.querySelector("#archive-session")).display; }, 700);
