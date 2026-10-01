import { useCallback, useEffect, useRef } from "react";
import { onChanged } from "./bridge";
import { refreshQuery, useRuntimeStore } from "./runtimeStore";

type Scope = "agents" | "tasks" | "health" | "conversations";

/**
 * Loads a keyed runtime query into the webview-wide Zustand cache and refreshes it on host changes.
 * Existing data stays visible while reloads run or fail.
 */
export function useData<T>(load: () => Promise<T>, options: { key: string; scopes: Scope[]; taskId?: string; enabled?: boolean }) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = options.enabled ?? true;
  const data = useRuntimeStore(state => state.queries[options.key]?.data as T | undefined);
  const error = useRuntimeStore(state => state.queries[options.key]?.error);

  const reload = useCallback((force = false) => refreshQuery(options.key, () => loadRef.current(), force), [options.key]);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload, options.taskId]);

  const scopeKey = options.scopes.join(",");
  useEffect(() => onChanged(change => {
    if (!enabled) return;
    if (options.taskId && change.taskIds && !change.taskIds.includes(options.taskId)) return;
    if (change.scopes.some(scope => scopeKey.split(",").includes(scope))) void reload(true);
  }), [enabled, reload, scopeKey, options.taskId]);

  return { data, error, reload };
}
