// A brand-new chat with no history: home header, no back button or chat menu, no recent list.
setTimeout(() => {
  window.postMessage({ type: "sessions", currentId: null, recent: [], archived: [] }, "*");
  window.postMessage({ type: "session", id: null, title: null, archived: false, messages: [] }, "*");
}, 300);
setTimeout(() => {
  const shown = id => !document.querySelector(id).hidden;
  document.documentElement.dataset.debug = "home=" + document.querySelector("#shell").classList.contains("is-home") + " back=" + shown("#chat-back") + " more=" + shown("#chat-more") + " recents=" + shown("#home-recents");
}, 700);
