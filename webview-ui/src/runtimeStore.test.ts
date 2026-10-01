import { beforeEach, describe, expect, it } from "bun:test";
import { refreshQuery, useRuntimeStore } from "./runtimeStore";

beforeEach(() => useRuntimeStore.setState({ queries: {} }));

describe("webview runtime store", () => {
  it("keeps query data isolated by key", async () => {
    await refreshQuery("task:one", async () => ({ id: "one" }));
    await refreshQuery("task:two", async () => ({ id: "two" }));

    expect(useRuntimeStore.getState().queries).toMatchObject({
      "task:one": { data: { id: "one" } },
      "task:two": { data: { id: "two" } }
    });
  });

  it("shares an in-flight request and reruns once when the host invalidates it", async () => {
    let finishFirst!: (value: string) => void;
    let calls = 0;
    const firstResult = new Promise<string>(resolve => { finishFirst = resolve; });
    const load = async () => {
      calls += 1;
      return calls === 1 ? firstResult : "refreshed";
    };

    const first = refreshQuery("overview", load);
    const shared = refreshQuery("overview", load);
    const changed = refreshQuery("overview", load, true);
    finishFirst("initial");
    await Promise.all([first, shared, changed]);

    expect(calls).toBe(2);
    expect(useRuntimeStore.getState().queries.overview).toEqual({ data: "refreshed", error: undefined });
  });
});
