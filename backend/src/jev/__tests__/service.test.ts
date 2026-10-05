import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDatabase } from "../../persistence/database";
import { coerceEntityType, normalizeName, normalizePredicate } from "../model";
import { JevService } from "../service";

let dir: string;
let db: AgentDatabase;
let jev: JevService;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jev-")); db = new AgentDatabase(dir); jev = new JevService(db.connection); });
afterEach(() => { db.connection.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const count = (sql: string, ...params: Array<string | number>) => (db.connection.prepare(sql).get(...params) as { n: number }).n;
const relation = (id: string) => db.connection.prepare("SELECT active, valid_to, confidence FROM relations WHERE id = ?").get(id) as { active: number; valid_to: string | null; confidence: number };

describe("JEV vocabulary", () => {
  it("normalises names, types and predicates", () => {
    expect(normalizeName("  Auth   Service. ")).toBe("auth service");
    expect(coerceEntityType("Library")).toBe("technology");
    expect(coerceEntityType("table")).toBe("entity");
    expect(coerceEntityType("whatever")).toBe("concept");
    expect(normalizePredicate("Uses Port")).toBe("uses_port");
    expect(normalizePredicate("usesPort")).toBe("uses_port");
    expect(normalizePredicate("depends-on")).toBe("depends_on");
  });
});

describe("entities", () => {
  it("resolves the same thing to one row, by name or alias, and merges its data", () => {
    const first = jev.upsertEntity("service", "Auth Service", { owner: "team-a" });
    expect(jev.upsertEntity("service", "auth service.", { port: 8080 })).toBe(first);
    const withAlias = jev.upsertEntity("technology", "PostgreSQL", { aliases: ["Postgres"] });
    expect(jev.upsertEntity("technology", "postgres")).toBe(withAlias);
    const data = JSON.parse((db.connection.prepare("SELECT data_json FROM entities WHERE id = ?").get(first) as { data_json: string }).data_json);
    expect(data).toMatchObject({ owner: "team-a", port: 8080, displayName: "Auth Service" });
    expect(count("SELECT COUNT(*) AS n FROM entities")).toBe(2);
  });

  it("reuses rows written with the old free-form types instead of duplicating them", () => {
    db.connection.prepare("INSERT INTO entities(id, type, name, data_json) VALUES ('old', 'project', 'agent orchestrator', '{}')").run();
    expect(jev.upsertEntity("project", "Agent Orchestrator")).toBe("old");
  });
});

describe("facts", () => {
  it("strengthens a repeated fact instead of adding a row", () => {
    const first = jev.recordFact({ sourceName: "gateway", sourceType: "service", predicate: "uses", targetName: "FastAPI", targetType: "technology", confidence: .7 });
    const again = jev.recordFact({ sourceName: "Gateway", sourceType: "service", predicate: "uses", targetName: "fastapi", targetType: "technology", confidence: .7 });
    expect(again).toMatchObject({ outcome: "reinforced", relationId: first.relationId });
    expect(relation(first.relationId).confidence).toBeCloseTo(.75);
    expect(count("SELECT COUNT(*) AS n FROM relations")).toBe(1);
  });

  it("keeps several values for many-valued and unknown predicates", () => {
    jev.recordFact({ sourceName: "gateway", predicate: "uses", targetName: "FastAPI" });
    const redis = jev.recordFact({ sourceName: "gateway", predicate: "uses", targetName: "Redis" });
    const custom = jev.recordFact({ sourceName: "gateway", predicate: "talks_to", targetName: "billing" });
    jev.recordFact({ sourceName: "gateway", predicate: "talks_to", targetName: "search" });
    expect(redis.outcome).toBe("inserted");
    expect(custom.outcome).toBe("inserted");
    expect(count("SELECT COUNT(*) AS n FROM relations WHERE active = 1")).toBe(4);
  });

  it("replaces the current value of a single-valued predicate and keeps the old one as history", () => {
    const old = jev.recordFact({ sourceName: "gateway", sourceType: "service", predicate: "uses_port", targetName: "8080" });
    const next = jev.recordFact({ sourceName: "gateway", sourceType: "service", predicate: "Uses Port", targetName: "9090" });
    expect(next).toMatchObject({ outcome: "replaced", replaced: [{ relationId: old.relationId }] });
    expect(relation(old.relationId)).toMatchObject({ active: 0 });
    expect(relation(old.relationId).valid_to).toBeTruthy();
    expect(count("SELECT COUNT(*) AS n FROM relations WHERE predicate = 'uses_port' AND active = 1")).toBe(1);
  });

  it("changes nothing when a fact cannot be recorded", () => {
    expect(() => jev.recordFact({ sourceName: "gateway", predicate: "uses", targetName: "   " })).toThrow("must not be empty");
    // The source entity created before the failure is rolled back with it.
    expect(count("SELECT COUNT(*) AS n FROM entities")).toBe(0);
  });
});

describe("task links and retrieval", () => {
  it("links files to a task and never downgrades an edit to a read", () => {
    const id = jev.linkFile("t1", "./src/auth/login.ts", "edited")!;
    jev.linkFile("t1", "src/auth/login.ts", "read");
    expect(db.connection.prepare("SELECT weight FROM task_entities WHERE task_id = 't1' AND entity_id = ?").get(id)).toEqual({ weight: 1 });
  });

  it("finds the facts around what a request names, with display names and refs", () => {
    jev.recordFact({ sourceName: "Gateway", sourceType: "service", predicate: "uses_port", targetName: "8080" });
    jev.recordFact({ sourceName: "Gateway", sourceType: "service", predicate: "depends_on", targetName: "Redis", targetType: "technology" });
    jev.recordFact({ sourceName: "Billing", sourceType: "service", predicate: "uses", targetName: "Stripe" });
    const { entities, facts } = jev.retrieve({ query: "Which port does the gateway listen on?" });
    expect(entities.map(entity => entity.name)).toContain("Gateway");
    expect(facts.map(fact => fact.text).sort()).toEqual(["Gateway --depends_on--> Redis", "Gateway --uses_port--> 8080"]);
    expect(facts[0].refs[0]).toMatch(/^entity:\/\//);
  });

  it("ignores question filler when matching entity names", () => {
    jev.recordFact({ sourceName: "Gateway", sourceType: "service", predicate: "uses_port", targetName: "8080" });
    const filler = jev.upsertEntity("concept", "What does it do");

    const { entities, facts } = jev.retrieve({ query: "What does the gateway do?" });

    expect(entities.map(entity => entity.name)).toContain("Gateway");
    expect(entities.map(entity => entity.id)).not.toContain(filler);
    expect(facts.map(item => item.text)).toEqual(["Gateway --uses_port--> 8080"]);
  });

  it("brings in what earlier turns of the same chat touched", () => {
    const fileId = jev.linkFile("task-1", "src/auth/login.ts", "edited")!;
    jev.recordFact({ sourceName: "src/auth/login.ts", sourceType: "file", predicate: "calls", targetName: "session store" });
    db.trace("chat-1", "task-1", "coder", "tool", {});
    // A follow-up that names nothing still sees the file the chat worked on, and its facts.
    const { entities, facts } = jev.retrieve({ query: "now add tests", conversationId: "chat-1" });
    expect(entities.map(entity => entity.id)).toContain(fileId);
    expect(facts.map(fact => fact.text)).toEqual(["src/auth/login.ts --calls--> session store"]);
  });
});
