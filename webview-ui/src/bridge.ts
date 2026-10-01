import type { MethodName, Methods, Surface, ToHost, ToWebview } from "@shared/protocol";

type Changed = Extract<ToWebview, { kind: "changed" }>;
type Init = Extract<ToWebview, { kind: "init" }>;

const inVsCode = typeof acquireVsCodeApi === "function";
const api: VsCodeApi | undefined = inVsCode ? acquireVsCodeApi() : undefined;
/** The Agent Workbench desktop app serves the same data methods over Electron IPC. */
const desktop: DesktopWorkbenchApi | undefined = !inVsCode && typeof window !== "undefined" && typeof window.workbench?.workbenchRpc === "function" ? window.workbench : undefined;
export const inDesktop = Boolean(desktop);
type UiMethod = Extract<MethodName, `ui.${string}`>;
type UiHandler = <M extends UiMethod>(method: M, params: Methods[M]["params"]) => unknown;
/** In the desktop app, ui.* intents (open a task, navigate, chat) are handled by the renderer shell, not a host. */
let uiHandler: UiHandler | undefined;
export function setUiHandler(handler: UiHandler | undefined) { uiHandler = handler; }
const DESKTOP_STATE_KEY = "agent-workbench.ui";

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const changeListeners = new Set<(change: Changed) => void>();
let initMessage: Init | undefined;
const initListeners = new Set<(init: Init) => void>();
let nextId = 0;

desktop?.onWorkbenchChanged(change => changeListeners.forEach(listener => listener({ kind: "changed", ...change })));

window.addEventListener("message", event => {
  const message = event.data as ToWebview;
  if (!message || typeof message !== "object") return;
  if (message.kind === "response") {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.result);
    else call.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  } else if (message.kind === "changed") {
    changeListeners.forEach(listener => listener(message));
  } else if (message.kind === "init") {
    initMessage = message;
    initListeners.forEach(listener => listener(message));
  }
});

export function ready(surface: Surface) {
  const message: ToHost = { kind: "ready", surface };
  if (api) api.postMessage(message);
  else if (desktop) return; // The desktop shell passes context (e.g. taskId) as props.
  else void import("./fixtures").then(({ fixtureInit }) => {
    initMessage = { kind: "init", surface, context: fixtureInit(surface) };
    initListeners.forEach(listener => listener(initMessage!));
  });
}

export function onInit(listener: (init: Init) => void) {
  initListeners.add(listener);
  if (initMessage) listener(initMessage);
  return () => { initListeners.delete(listener); };
}

export function call<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
  if (desktop) {
    if (method.startsWith("ui.")) return Promise.resolve(uiHandler?.(method as UiMethod, params as never) ?? null) as Promise<Methods[M]["result"]>;
    return desktop.workbenchRpc(method, params).catch((error: unknown) => {
      // Electron wraps handler errors as "Error invoking remote method '…': Error: <message>".
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""));
    }) as Promise<Methods[M]["result"]>;
  }
  if (!api) return import("./fixtures").then(({ fixtureCall }) => fixtureCall(method, params)) as Promise<Methods[M]["result"]>;
  const id = `r${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 15_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    const message: ToHost = { kind: "request", id, method, params };
    api.postMessage(message);
  });
}

export function onChanged(listener: (change: Changed) => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** UI-only state (tabs, toggles, collapsed sections) that survives the webview being hidden or reloaded. */
export function loadUiState<T extends object>(defaults: T): T {
  const saved = desktop ? readDesktopState() : api?.getState();
  return saved && typeof saved === "object" ? { ...defaults, ...(saved as Partial<T>) } : defaults;
}

export function saveUiState(state: object) {
  if (desktop) {
    try { localStorage.setItem(DESKTOP_STATE_KEY, JSON.stringify({ ...readDesktopState(), ...state })); } catch { /* storage unavailable: state lasts for this session only */ }
    return;
  }
  api?.setState({ ...(api.getState() as object | undefined), ...state });
}

function readDesktopState(): object | undefined {
  try { return JSON.parse(localStorage.getItem(DESKTOP_STATE_KEY) ?? "null") ?? undefined; } catch { return undefined; }
}
