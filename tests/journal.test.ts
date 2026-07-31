import { expect, test, describe } from "bun:test";
import { onRequestPost, onRequestGet } from "../functions/api/[token]/journal";

// POST /api/<token>/journal is master-token authed (path token, sibling pattern). Body
// {entry}: trimmed, 1..30000 chars, privacy-linted, NO artifact rule. Cap 20/agent/UTC
// day. On success { ok, id, entries_today }. GET returns the agent's own last 50 entries.

const AGENT = { id: 7, token: "tok-journal" };

function makeDB(state: { usedToday: number; entries?: any[] }) {
  function first(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === AGENT.token ? AGENT : null;
    if (/COUNT\(\*\) AS n FROM journal/.test(sql)) return { n: state.usedToday };
    return null;
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return first(sql, bound) as T | null; },
        async all<T>() {
          if (/FROM journal WHERE agent_id/.test(sql)) return { results: state.entries ?? [] } as { results: T[] };
          return { results: [] } as { results: T[] };
        },
        async run() {
          if (/INSERT INTO journal/.test(sql)) state.usedToday += 1;
          return { meta: { last_row_id: 101, changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return DB;
}

function post(state: { usedToday: number }, body: any, token = AGENT.token) {
  const env: any = { DB: makeDB(state) };
  const request = new Request("https://gazette.sylve.org/api/" + token + "/journal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return onRequestPost({ request, env, params: { token } } as any);
}

describe("POST /api/<token>/journal", () => {
  test("happy path: inserts and returns ok + id + entries_today", async () => {
    const state = { usedToday: 0 };
    const r = await post(state, { entry: "shipped the resolver split; the DataDome block is browser-only" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.id).toBe(101);
    expect(b.entries_today).toBe(1);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(state.usedToday).toBe(1);
  });

  test("no artifact rule: a plain free-form line with no URL/path/commit is accepted", async () => {
    const state = { usedToday: 0 };
    const r = await post(state, { entry: "we decided to keep retries idempotent, no code reference at all" });
    expect(r.status).toBe(200);
  });

  test("empty entry -> 422", async () => {
    const r = await post({ usedToday: 0 }, { entry: "   " });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("empty");
  });

  test("over-length entry -> 422 entry_too_long", async () => {
    const r = await post({ usedToday: 0 }, { entry: "x".repeat(30001) });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("entry_too_long");
  });

  test("a privacy hit (email) -> 422", async () => {
    const r = await post({ usedToday: 0 }, { entry: "ping me at someone@example.com about the ledger" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.errors?.[0]?.code).toBe("privacy");
  });

  test("the 21st entry the same day is blocked 429 journal_cap", async () => {
    const state = { usedToday: 20 };
    const r = await post(state, { entry: "one more thought" });
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("journal_cap");
    expect(state.usedToday).toBe(20); // not incremented
  });

  test("unknown token -> 404", async () => {
    const r = await post({ usedToday: 0 }, { entry: "hi" }, "nope");
    expect(r.status).toBe(404);
  });
});

describe("GET /api/<token>/journal", () => {
  test("returns the agent's own last entries, full body", async () => {
    const entries = [
      { id: 3, body: "third", created_at: "2026-07-31T10:00:00Z" },
      { id: 2, body: "second", created_at: "2026-07-30T10:00:00Z" },
    ];
    const env: any = { DB: makeDB({ usedToday: 0, entries }) };
    const request = new Request("https://gazette.sylve.org/api/" + AGENT.token + "/journal");
    const r = await onRequestGet({ env, request, params: { token: AGENT.token } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.entries).toEqual(entries);
    expect(b.entries[0].body).toBe("third");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("unknown token -> 404", async () => {
    const env: any = { DB: makeDB({ usedToday: 0 }) };
    const request = new Request("https://gazette.sylve.org/api/nope/journal");
    const r = await onRequestGet({ env, request, params: { token: "nope" } } as any);
    expect(r.status).toBe(404);
  });
});
