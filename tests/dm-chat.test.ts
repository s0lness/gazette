import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost } from "../functions/api/dm/[handle]";

// The global agent ask is a multi-turn chat now: 10 messages per (member, agent, UTC
// day). We assert a 2nd message the same day is allowed and the 11th is blocked. The
// fake D1 tracks how many dm_log rows this (visitor, agent, day) already has via a
// mutable counter; the endpoint reads it with COUNT(*).

const AGENT = { id: 5, handle: "yuka" };
const REQUESTER = { id: 42, handle: "asker", token: "tok-asker" };

function makeDB(state: { used: number }) {
  const dailies = [{ date: "2026-07-30", headline: "shipped a fix", body_md: "work" }];
  // authMember (token + daily count) and the handle lookup stay as .first() reads. The
  // pre-oracle reads (quota COUNT, IP COUNT, corpus, history) now run in ONE db.batch,
  // so resolveAll answers each by its SQL and batch maps over the statements.
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === REQUESTER.token ? REQUESTER : null;
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 1 };
    if (/FROM agents WHERE handle/.test(sql)) return bound[0] === AGENT.handle ? AGENT : null;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/COUNT\(\*\) AS n FROM dm_log WHERE visitor_hash/.test(sql)) return { results: [{ n: state.used }] };
    if (/COUNT\(\*\) AS n FROM dm_log WHERE ip_hash/.test(sql)) return { results: [{ n: 0 }] };
    if (/FROM dailies WHERE agent_id/.test(sql)) return { results: dailies };
    // history load (dm_log visitor_hash ... LIMIT) + anything else: empty
    return { results: [] };
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
        async run() {
          if (/INSERT INTO dm_log/.test(sql)) state.used += 1;
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return DB;
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function stubAnthropic(text: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
}

function call(state: { used: number }, question = "What did you ship?") {
  const env: any = { DB: makeDB(state), ANTHROPIC_API_KEY: "sk-test" };
  const request = new Request("https://gazette.sylve.org/api/dm/yuka", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gz-token": REQUESTER.token },
    body: JSON.stringify({ question }),
  });
  return onRequestPost({ request, env, params: { handle: "yuka" } } as any);
}

describe("DM chat quota (10/day, multi-turn)", () => {
  test("first message leaves remaining 9", async () => {
    stubAnthropic("I shipped a fix.");
    const state = { used: 0 };
    const r = await call(state);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.remaining).toBe(9);
    expect(state.used).toBe(1);
  });

  test("a 2nd message the same day is allowed", async () => {
    stubAnthropic("Follow-up answer.");
    const state = { used: 1 }; // one already sent today
    const r = await call(state, "and what broke?");
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.remaining).toBe(8); // 10 - 1 used - this one
  });

  test("the 11th message is blocked with 429 quota", async () => {
    stubAnthropic("should not be reached");
    const state = { used: 10 }; // already at the cap
    const r = await call(state, "one more?");
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("quota");
    expect(b.message).toContain("10 messages");
    // Quota burn was not incremented (blocked before insert).
    expect(state.used).toBe(10);
  });
});
