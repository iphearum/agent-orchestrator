// Opens the combined model + reasoning effort popup and moves the slider to Medium.
// Add --hash models to show the model list view instead. Checks: pill label, slider state, which view is open.
setTimeout(() => {
  document.querySelector("#model-button").click();
  const slider = document.querySelector("#effort-slider");
  slider.value = "2";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  if (location.hash === "#models") document.querySelector("#me-open-models").click();
  setTimeout(() => {
    const visible = id => !document.querySelector(id).hidden;
    document.documentElement.dataset.debug = "pill=" + document.querySelector("#model-button").textContent.trim()
      + " effort=" + document.querySelector("#me-effort-name").textContent
      + " menu=" + visible("#model-menu") + " effortView=" + visible("#me-effort") + " modelView=" + visible("#me-models");
  }, 300);
}, 400);
