import { afterEach, describe, expect, it } from "bun:test";
import { keepAliveMs, LayaHttpClient, readChoice, readYesNo, shouldRetryLaya } from "../layaClient";
import type { AgentState } from "../../core/types";

const state: AgentState = { agentId: "lead", agentName: "Lead", message: "Fix the login bug in auth.ts", availableTools: ["read_file", "run_command"] };
const agents = [
  { id: "coder", name: "Coder", description: "Writes code", skills: ["typescript"] },
  { id: "researcher", name: "Researcher", description: "Finds information", skills: ["search"] }
];

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

/** A local stand-in for the Laya service that records the request and answers like laya-multilingual. */
function fakeLaya(answers: Record<string, unknown>) {
  const requests: any[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ auth: request.headers.get("authorization"), body: await request.json() });
      return Response.json({ model: "laya-multilingual", answers, usage: { input_tokens: 172, output_tokens: 0 } });
    }
  });
  return { url: `http://127.0.0.1:${server.port}/v1/systemone`, requests };
}

describe("readYesNo / readChoice", () => {
  it("reads laya-multilingual noul answers as the probability of yes", () => {
    expect(readYesNo({ type: "noul", noul: 0.9794 })).toEqual({ value: true, confidence: 0.9794 });
    // A low probability is a confident "no", not an unsure "yes".
    expect(readYesNo({ type: "noul", noul: 0.02 })).toEqual({ value: false, confidence: 0.98 });
    expect(readYesNo({ type: "noul", noul: 3 })).toEqual({ value: true, confidence: 1 });
  });

  it("still accepts the older yes/no choice answers", () => {
    expect(readYesNo({ choice: "yes", probability: 0.8 })).toEqual({ value: true, confidence: 0.8 });
    expect(readYesNo({ choice: "No", confidence: 0.7 })).toEqual({ value: false, confidence: 0.7 });
    expect(readYesNo({ choice: "maybe" })).toBeUndefined();
    expect(readYesNo(undefined)).toBeUndefined();
  });

  it("takes choice confidence from confidence, then probability, then the chosen option's probability", () => {
    expect(readChoice({ type: "choice", choice: "billing", confidence: 1.0, probabilities: { billing: 1.0, technical: 0 } })).toEqual({ value: "billing", confidence: 1 });
    expect(readChoice({ type: "choice", choice: "coder", probabilities: { coder: 0.64, researcher: 0.36 } })).toEqual({ value: "coder", confidence: 0.64 });
    // Laya's confidence measures spread, not likelihood: act on the chosen option's probability.
    expect(readChoice({ type: "choice", choice: "coder", confidence: 0.2, probabilities: { coder: 0.9, researcher: 0.1 } })).toEqual({ value: "coder", confidence: 0.9 });
    expect(readChoice({ type: "choice", choice: "coder" })).toEqual({ value: "coder", confidence: 0.5 });
    expect(readChoice({ type: "score", score: 1.9 })).toBeUndefined();
  });
});

describe("LayaHttpClient", () => {
  it("routes with only the agent question, and sends the model and keep_alive", async () => {
    const laya = fakeLaya({
      agent: { type: "choice", choice: "coder", confidence: 0.93, probabilities: { coder: 0.93, researcher: 0.07 } },
      urgency: { type: "score", score: 1.9005, confidence: 0.698, legend: { "0": "not urgent", "2": "today" } }
    });
    const client = new LayaHttpClient(() => ({ endpoint: laya.url, apiKey: "secret", model: " laya-multilingual ", keepAlive: " 30m ", timeoutMs: 2000 }));
    const result = await client.decide(state, "global", agents);

    const [request] = laya.requests;
    expect(request.auth).toBe("Bearer secret");
    expect(request.body.model).toBe("laya-multilingual");
    expect(request.body.keep_alive).toBe("30m");
    // Laya re-reads the state for every question, so routing asks only what runRoot acts on.
    expect(Object.keys(request.body.questions)).toEqual(["agent"]);
    expect(request.body.questions.agent.type).toBe("choice");
    expect(Object.keys(request.body.questions.agent.criteria).sort()).toEqual(["coder", "researcher"]);
    // The roster is in the criteria; the state text doesn't repeat it.
    expect(request.body.state).not.toContain("Available agents");

    expect(result).toEqual({ agent: { value: "coder", confidence: 0.93 }, routing: undefined });
    expect(client.status.connected).toBe(true);
  });

  it("retries without keep_alive when a Decision API rejects it, then stops sending it", async () => {
    const requests: Array<Record<string, unknown>> = [];
    server = Bun.serve({ port: 0, async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      requests.push(body);
      return "keep_alive" in body
        ? Response.json({ detail: { error_type: "api_usage_error", message: "Unsupported field(s): keep_alive" } }, { status: 400 })
        : Response.json({ answers: { agent: { type: "choice", choice: "coder", probabilities: { coder: 0.9, researcher: 0.1 } } } });
    } });
    const client = new LayaHttpClient(() => ({ endpoint: `http://127.0.0.1:${server!.port}/v1/systemone`, keepAlive: "30m", timeoutMs: 2000 }));

    expect((await client.decide(state, "global", agents)).agent).toEqual({ value: "coder", confidence: 0.9 });
    expect(requests.map(body => "keep_alive" in body)).toEqual([true, false]);
    expect(client.status).toMatchObject({ connected: true, paused: false, consecutiveFailures: 0 });

    await client.decide(state, "global", agents);
    expect(requests.map(body => "keep_alive" in body)).toEqual([true, false, false]);
  });

  it("asks an agent only the retrieval and tool questions it acts on", async () => {
    const laya = fakeLaya({
      needs_memory: { type: "noul", noul: 0.9794 },
      needs_graph: { type: "noul", noul: 0.12 },
      tool: { type: "choice", choice: "workspace_read", confidence: 0.81 }
    });
    const client = new LayaHttpClient(() => ({ endpoint: laya.url, model: "laya-multilingual", timeoutMs: 2000 }));
    const long = "x".repeat(5000);
    const result = await client.decide({ ...state, recentContextSummary: `${long}END`, currentTask: { id: "t1", instruction: state.message, status: "active" } }, "coder", agents);

    const { body } = laya.requests[0];
    expect(Object.keys(body.questions).sort()).toEqual(["needs_graph", "needs_memory", "tool"]);
    expect(body.questions.needs_memory).toEqual({ type: "noul", instructions: expect.any(String) });
    expect("keep_alive" in body).toBe(false);
    // Recent context is trimmed from the front, and a task that only repeats the message is left out.
    expect(body.state).toContain("END");
    expect(body.state.length).toBeLessThan(1600);
    expect(body.state).not.toContain("Current task");

    expect(result.needsMemory).toEqual({ value: true, confidence: 0.9794 });
    expect(result.needsGraph).toEqual({ value: false, confidence: 0.88 });
    expect(result.tool).toEqual({ value: "workspace_read", confidence: 0.81 });
    expect(result.agent).toBeUndefined();
  });

  it("omits the model when none is configured and treats missing answers as unsure", async () => {
    const laya = fakeLaya({ tool: { type: "choice", choice: "teleport", confidence: 0.9 } });
    const client = new LayaHttpClient(() => ({ endpoint: laya.url, timeoutMs: 2000 }));
    const result = await client.decide(state, "coder", agents);

    expect("model" in laya.requests[0].body).toBe(false);
    expect(laya.requests[0].auth).toBeNull();
    expect(result.agent).toBeUndefined();
    expect(result.needsMemory).toEqual({ value: false, confidence: 0.5 });
    // An option that was never offered falls back to "none".
    expect(result.tool.value).toBe("none");
  });

  it("refuses plain HTTP to a remote host", async () => {
    const client = new LayaHttpClient(() => ({ endpoint: "http://laya.example.com/v1/systemone", timeoutMs: 2000 }));
    await expect(client.decide(state, "general", [])).rejects.toThrow("HTTPS");
  });
  it("falls back for one slow answer without pausing, and gives the next request time to load the model", async () => {
    let delayMs = 0;
    server = Bun.serve({ port: 0, async fetch() {
      await Bun.sleep(delayMs);
      return Response.json({ answers: { needs_memory: { type: "noul", noul: 0.9 } } });
    } });
    const client = new LayaHttpClient(() => ({ endpoint: ` http://127.0.0.1:${server!.port}/v1/systemone `, timeoutMs: 150 }));
    await client.decide(state, "general", []);
    expect(client.status.lastLatencyMs).toBeLessThan(150);
    delayMs = 400;
    await expect(client.decide(state, "general", [])).rejects.toThrow(/timed out after 150ms \(the last answer took \d+ms\)/);
    expect(client.status).toMatchObject({ connected: false, paused: false, consecutiveFailures: 1 });
    // The model may still be loading: the next request waits past the normal timeout instead of falling back again.
    await client.decide(state, "general", []);
    expect(client.status).toMatchObject({ connected: true, paused: false, consecutiveFailures: 0 });
  });

  it("pauses after repeated transient failures", async () => {
    let calls = 0;
    server = Bun.serve({ port: 0, fetch() { calls++; return new Response("overloaded", { status: 503 }); } });
    const client = new LayaHttpClient(() => ({ endpoint: `http://127.0.0.1:${server!.port}/v1/systemone`, timeoutMs: 1000 }));
    for (let i = 0; i < 2; i++) await expect(client.decide(state, "general", [])).rejects.toThrow("HTTP 503");
    expect(client.status.paused).toBe(false);
    await expect(client.decide(state, "general", [])).rejects.toThrow("HTTP 503");
    expect(client.status.paused).toBe(true);
    await expect(client.decide(state, "general", [])).rejects.toThrow("Laya is paused");
    expect(calls).toBe(3);
  });

  it("stays paused after a permanent failure until it is resumed, tested successfully, or reconfigured", async () => {
    let calls = 0;
    let failing = true;
    server = Bun.serve({ port: 0, fetch() {
      calls++;
      return failing ? new Response("bad key", { status: 401 }) : Response.json({ answers: { needs_memory: { type: "noul", noul: 0.9 } } });
    } });
    let apiKey = "one";
    const client = new LayaHttpClient(() => ({ endpoint: `http://127.0.0.1:${server!.port}/v1/systemone`, apiKey, timeoutMs: 1000 }));
    await expect(client.decide(state, "general", [])).rejects.toThrow("HTTP 401");
    failing = false;
    // Paused: chats do not call Laya again, however many decisions they make.
    for (let i = 0; i < 3; i++) await expect(client.decide(state, "general", [])).rejects.toThrow("Laya is paused");
    expect(calls).toBe(1);

    client.resume();
    await client.decide(state, "general", []);
    expect(calls).toBe(2);
    expect(client.status).toMatchObject({ connected: true, paused: false });

    // A connection test that succeeds resumes a paused client.
    failing = true;
    await expect(client.decide(state, "general", [])).rejects.toThrow("HTTP 401");
    failing = false;
    await client.ping();
    expect(client.status.paused).toBe(false);

    // A new key (or endpoint/model) resumes too, since it may be what fixes the failure.
    failing = true;
    await expect(client.decide(state, "general", [])).rejects.toThrow("HTTP 401");
    failing = false;
    apiKey = "two";
    await client.decide(state, "general", []);
    expect(client.status.paused).toBe(false);
  });

  it("waits out a cold start in the connection test and reports the warm latency", async () => {
    let calls = 0;
    server = Bun.serve({ port: 0, async fetch() {
      if (++calls === 1) await Bun.sleep(300); // model loading
      return Response.json({ answers: { needs_llm: { type: "noul", noul: 0.9 } } });
    } });
    const client = new LayaHttpClient(() => ({ endpoint: `http://127.0.0.1:${server!.port}/v1/systemone`, timeoutMs: 100 }));
    const result = await client.ping();
    expect(calls).toBe(2);
    expect(result.coldStartMs).toBeGreaterThanOrEqual(300);
    expect(result.latencyMs).toBeLessThan(100);
    expect(client.status.connected).toBe(true);
  });

  it("tests the connection with the same routing request a chat starts with", async () => {
    const laya = fakeLaya({ agent: { type: "choice", choice: "coder", confidence: 0.9 }, needs_llm: { type: "noul", noul: 0.9 } });
    const client = new LayaHttpClient(() => ({ endpoint: laya.url, timeoutMs: 2000 }));
    const lead = { id: "lead", name: "Lead", description: "Coordinates", skills: [] };
    const result = await client.ping([lead, ...agents]);

    const { questions } = laya.requests[0].body;
    expect(Object.keys(questions.agent.criteria).sort()).toEqual(["coder", "lead", "researcher"]);
    // Like a normal chat's routing request: no team questions (those come only with team-sized requests).
    expect(questions.team).toBeUndefined();
    expect(Object.keys(questions).some(key => key.startsWith("team_worker_"))).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("shouldRetryLaya", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const pausedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  it("checks a paused client once per interval, and never when retries are off", () => {
    expect(shouldRetryLaya({ paused: false }, 0, 5, now)).toBe(false);
    expect(shouldRetryLaya({ paused: true, pausedAt: pausedAt(10) }, 0, 0, now)).toBe(false);
    expect(shouldRetryLaya({ paused: true, pausedAt: pausedAt(4) }, 0, 5, now)).toBe(false);
    expect(shouldRetryLaya({ paused: true, pausedAt: pausedAt(6) }, 0, 5, now)).toBe(true);
    // The last check counts too, so a still-down service is not asked every tick.
    expect(shouldRetryLaya({ paused: true, pausedAt: pausedAt(30) }, now - 2 * 60_000, 5, now)).toBe(false);
  });
});

describe("keepAliveMs", () => {
  it("reads Ollama keep_alive durations, defaulting to Ollama's five minutes", () => {
    expect(keepAliveMs("30m")).toBe(30 * 60_000);
    expect(keepAliveMs("2h")).toBe(2 * 3_600_000);
    expect(keepAliveMs("90")).toBe(90_000);
    expect(keepAliveMs("-1")).toBe(Number.POSITIVE_INFINITY);
    expect(keepAliveMs("")).toBe(5 * 60_000);
    expect(keepAliveMs("soon")).toBe(5 * 60_000);
  });
});
