import { afterEach, describe, expect, it } from "bun:test";
import { LayaHttpClient } from "../../integrations/layaClient";
import { decideDiscussion, discussionQuestions, readDiscussionAnswers } from "../policies/discussion";

const thresholds = { automatic: .9, enrichment: .65 };
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

function fakeLaya(answers: object) {
  const requests: any[] = [];
  server = Bun.serve({ port: 0, fetch: async request => { requests.push(await request.json()); return Response.json({ answers }); } });
  return { requests, client: new LayaHttpClient(() => ({ endpoint: `http://127.0.0.1:${server!.port}/v1/systemone`, timeoutMs: 2000 })) };
}

describe("discussion Laya policy", () => {
  it("asks only what the reply will use", () => {
    expect(Object.keys(discussionQuestions(false))).toEqual(["effort"]);
    expect(Object.keys(discussionQuestions(true))).toEqual(["effort", "consult"]);
    expect(Object.keys(discussionQuestions(true, false))).toEqual(["consult"]);
  });

  it("uses a confident Laya effort and gates the consult answer", () => {
    const decision = readDiscussionAnswers({
      effort: { type: "choice", choice: "high", probabilities: { high: .8, medium: .15, low: .05 } },
      consult: { type: "noul", noul: .03 }
    }, { prompt: "Hello", supervisor: true }, thresholds);
    expect(decision).toEqual({ effort: { value: "high", confidence: .8, source: "laya" }, consult: { value: false, confidence: .97, mode: "execute" }, source: "laya" });
  });

  it("falls back to the estimate when Laya is unsure or answers off-list", () => {
    const unsure = readDiscussionAnswers({ effort: { choice: "high", probabilities: { high: .4 } } }, { prompt: "Hello", supervisor: false }, thresholds);
    expect(unsure.effort).toEqual({ value: "low", confidence: 1, source: "rules" });
    expect(unsure.fallbackReason).toContain("unsure");
    expect(readDiscussionAnswers({ effort: { choice: "extreme", probability: .99 } }, { prompt: "Hello", supervisor: false }, thresholds).source).toBe("rules");
  });

  it("never waits on a cold Laya: it falls back, warms up in the background, then uses Laya", async () => {
    const { client, requests } = fakeLaya({ effort: { type: "choice", choice: "medium", probabilities: { medium: .93 } } });
    const first = await decideDiscussion(client, { prompt: "Hello", supervisor: false }, thresholds);
    expect(first.source).toBe("rules");
    expect(first.fallbackReason).toContain("loading");
    for (let i = 0; i < 50 && !client.status.lastSuccessAt; i++) await Bun.sleep(10);
    const second = await decideDiscussion(client, { prompt: "How should we design storage?", supervisor: false }, thresholds);
    expect(second.effort).toEqual({ value: "medium", confidence: .93, source: "laya" });
    expect(Object.keys(requests.at(-1).questions)).toEqual(["effort"]);
    expect(JSON.stringify(requests.at(-1).state)).toContain("How should we design storage?");
  });

  it("falls back with the reason when Laya is off or unreachable", async () => {
    expect(await decideDiscussion(undefined, { prompt: "Hello", supervisor: false }, thresholds)).toMatchObject({ source: "rules", fallbackReason: "Laya is off." });
    const client = new LayaHttpClient(() => ({ endpoint: "http://127.0.0.1:9/v1/systemone", timeoutMs: 200 }));
    await client.warmUp();
    const decision = await decideDiscussion(client, { prompt: "Why does this crash? ```TypeError: x```", supervisor: false }, thresholds);
    expect(decision.source).toBe("rules");
    expect(decision.effort.value).toBe("high");
    expect(decision.fallbackReason).toBeTruthy();
  });
});
