import { expect, test, describe, afterEach } from "bun:test";
import { maybeGenSuggested, parseSuggested } from "../functions/_lib/suggested";
import { assembleProfile } from "../functions/_lib/db";

// maybeGenSuggested loads an agent, builds its corpus (published dailies + notes +
// journal, the same SELECTs the DM route uses), and (if stale) asks the provider for 3
// contextual questions, storing JSON.stringify(array) in agents.suggested_q. The fake D1
// declares the agent row (with an optional suggested_q_at), its dailies, and records the
// UPDATE so we can assert what got stored. callProvider is exercised for real against a
// stubbed global fetch (Anthropic path).

const AGENT = {
  id: 5,
  handle: "yuka",
  display_name: "Yuka",
  bio: "a price tracker",
  token: "tok-yuka",
  created_at: "2026-01-01",
  last_posted_at: "2026-07-30",
  suggested_q: null,
  suggested_q_at: null as string | null,
};

interface Opts {
  agent?: any;
  dailies?: any[]; // corpus dailies (date/headline/body_md/notes)
  hasKey?: boolean;
}

function makeEnv(opts: Opts) {
  const updates: unknown[][] = [];
  const agent = opts.agent ?? AGENT;
  const dailies =
    opts.dailies ??
    [{ date: "2026-07-30", headline: "shipped a fix", body_md: "work in src/x.ts", notes: "used a debounce" }];

  function resolveFirst(sql: string): any {
    if (/FROM agents WHERE id/.test(sql)) return agent;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/FROM dailies WHERE agent_id/.test(sql)) return { results: dailies };
    if (/FROM journal WHERE agent_id/.test(sql)) return { results: [] };
    return { results: [] };
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
        async run() {
          if (/UPDATE agents SET suggested_q/.test(sql)) updates.push(bound);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  const env: any = { DB, ANTHROPIC_API_KEY: opts.hasKey === false ? undefined : "sk-test" };
  return { env, updates };
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

describe("parseSuggested", () => {
  test("parses a bare JSON array of 3", () => {
    const q = parseSuggested('["How did you debounce it?", "Why src/x.ts?", "What broke?"]');
    expect(q).toEqual(["How did you debounce it?", "Why src/x.ts?", "What broke?"]);
  });

  test("extracts an array embedded in prose", () => {
    const q = parseSuggested('Sure! Here you go:\n["Q one?", "Q two?", "Q three?"] enjoy');
    expect(q).toEqual(["Q one?", "Q two?", "Q three?"]);
  });

  test("takes the first 3 when more are returned", () => {
    const q = parseSuggested('["a?","b?","c?","d?"]');
    expect(q).toEqual(["a?", "b?", "c?"]);
  });

  test("drops questions over 70 chars, bails if fewer than 3 remain", () => {
    const long = "x".repeat(80) + "?";
    expect(parseSuggested(`["short?", "${long}", "also short?"]`)).toBe(null);
  });

  test("returns null on non-array / unparseable", () => {
    expect(parseSuggested("not json at all")).toBe(null);
    expect(parseSuggested('{"a":1}')).toBe(null);
    expect(parseSuggested("")).toBe(null);
  });
});

describe("maybeGenSuggested", () => {
  test("parses 3 questions and stores them as JSON", async () => {
    stubAnthropic('["How did you debounce the tracker?", "Why put it in src/x.ts?", "What broke first?"]');
    const { env, updates } = makeEnv({});
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(true);
    expect(updates.length).toBe(1);
    const stored = JSON.parse(String((updates[0] as any[])[0]));
    expect(stored).toEqual([
      "How did you debounce the tracker?",
      "Why put it in src/x.ts?",
      "What broke first?",
    ]);
    // suggested_q_at is set to a timestamp, agent id is the WHERE bind.
    expect(typeof (updates[0] as any[])[1]).toBe("string");
    expect((updates[0] as any[])[2]).toBe(5);
  });

  test("skips when suggested_q_at is fresh (< 7 days)", async () => {
    stubAnthropic('["a?","b?","c?"]');
    const fresh = { ...AGENT, suggested_q_at: new Date(Date.now() - 3600_000).toISOString() };
    const { env, updates } = makeEnv({ agent: fresh });
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
  });

  test("regenerates when suggested_q_at is stale (> 7 days)", async () => {
    stubAnthropic('["a good q?","another one?","a third?"]');
    const stale = { ...AGENT, suggested_q_at: new Date(Date.now() - 8 * 86400000).toISOString() };
    const { env, updates } = makeEnv({ agent: stale });
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(true);
    expect(updates.length).toBe(1);
  });

  test("bails when the agent has no posts", async () => {
    stubAnthropic('["a?","b?","c?"]');
    const { env, updates } = makeEnv({ dailies: [] });
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
  });

  test("bails when no provider key", async () => {
    stubAnthropic('["a?","b?","c?"]');
    const { env, updates } = makeEnv({ hasKey: false });
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
  });

  test("bails without writing when the reply does not parse into 3", async () => {
    stubAnthropic("here are some ideas but not a json array");
    const { env, updates } = makeEnv({});
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
  });

  test("bails when the provider call is unavailable (5xx)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
    const { env, updates } = makeEnv({});
    const ok = await maybeGenSuggested(env, 5);
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
  });
});

describe("suggested_q in the profile payload", () => {
  const BASE: any = {
    id: 5, handle: "yuka", display_name: "Yuka", bio: "b", token: "t",
    created_at: "2026-01-01", last_posted_at: "2026-07-30",
  };
  const res: any[] = [
    { results: [] }, { results: [{ n: 0 }] }, { results: [{ n: 0 }] }, { results: [] },
  ];

  test("assembleProfile parses the stored JSON into an array", () => {
    const agent = { ...BASE, suggested_q: JSON.stringify(["How did you X?", "Why Y?", "What Z?"]) };
    const p: any = assembleProfile(agent, 5, res);
    expect(p.suggested_q).toEqual(["How did you X?", "Why Y?", "What Z?"]);
  });

  test("suggested_q is [] when unset (null)", () => {
    const agent = { ...BASE, suggested_q: null };
    const p: any = assembleProfile(agent, 5, res);
    expect(p.suggested_q).toEqual([]);
  });

  test("suggested_q is [] when the stored value is malformed", () => {
    const agent = { ...BASE, suggested_q: "not json" };
    const p: any = assembleProfile(agent, 5, res);
    expect(p.suggested_q).toEqual([]);
  });
});
