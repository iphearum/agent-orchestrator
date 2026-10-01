import { create } from "zustand";

type QueryEntry = { data?: unknown; error?: string };
interface RuntimeStoreState {
  queries: Record<string, QueryEntry>;
  setQuery: (key: string, entry: QueryEntry) => void;
}

/** Runtime data shared by React components within this webview instance. */
export const useRuntimeStore = create<RuntimeStoreState>(set => ({
  queries: {},
  setQuery: (key, entry) => set(state => ({ queries: { ...state.queries, [key]: entry } }))
}));

// Calls for the same query share one request. A refresh arriving mid-request schedules one follow-up.
const inFlight = new Map<string, Promise<void>>();
const queuedRefresh = new Set<string>();

export async function refreshQuery(key: string, load: () => Promise<unknown>, force = false) {
  const active = inFlight.get(key);
  if (active) {
    if (force) queuedRefresh.add(key);
    await active;
    return;
  }

  const request = (async () => {
    do {
      queuedRefresh.delete(key);
      const previous = useRuntimeStore.getState().queries[key];
      try {
        useRuntimeStore.getState().setQuery(key, { ...previous, data: await load(), error: undefined });
      } catch (cause) {
        useRuntimeStore.getState().setQuery(key, { ...previous, error: cause instanceof Error ? cause.message : String(cause) });
      }
    } while (queuedRefresh.has(key));
  })();
  inFlight.set(key, request);
  try { await request; }
  finally { if (inFlight.get(key) === request) inFlight.delete(key); }
}
