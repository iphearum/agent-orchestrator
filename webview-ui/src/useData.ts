import { useCallback, useEffect, useRef, useState } from "react";
import { onChanged } from "./bridge";

type Scope = "agents" | "tasks" | "health" | "conversations";

/**
 * Loads data once, then reloads when the host reports a relevant change.
 * Keeps showing the previous data while a reload is in flight so the UI never flashes empty.
 */
export function useData<T>(load: () => Promise<T>, options: { scopes: Scope[]; taskId?: string; enabled?: boolean }) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);
  const again = useRef(false);
  const enabled = options.enabled ?? true;

  const reload = useCallback(async () => {
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        setData(await loadRef.current());
        setError(undefined);
      } while (again.current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { if (enabled) void reload(); }, [enabled, reload, options.taskId]);

  const scopeKey = options.scopes.join(",");
  useEffect(() => onChanged(change => {
    if (!enabled) return;
    if (options.taskId && change.taskIds && !change.taskIds.includes(options.taskId)) return;
    if (change.scopes.some(scope => scopeKey.includes(scope))) void reload();
  }), [enabled, reload, scopeKey, options.taskId]);

  return { data, error, reload };
}
