export function getDesktopBridge() {
  if (typeof window === "undefined" || !window.workbench) {
    throw new Error("The desktop bridge is unavailable. Open this renderer through the Agent Workbench desktop app.");
  }
  return window.workbench;
}

export function hasDesktopBridge() {
  return typeof window !== "undefined" && Boolean(window.workbench);
}
