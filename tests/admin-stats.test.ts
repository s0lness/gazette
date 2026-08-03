import { expect, test, describe, afterEach } from "bun:test";
import { onRequestGet } from "../functions/api/admin/stats";

// Fake D1 for /api/admin/stats. The handler runs exactly two batches:
//   1. nine scalar COUNT statements (seven totals + the two `excluded` disclosure counts)
//   2. seven statements: signups/day, posts/day, dm/day, a small agents read
//      (last_posted_at) for health, top agents, recent signups, recent posts.
// The fake answers each statement by matching the SQL it carries, in the order
// the batch was built (each prepared statement resolves itself).
//
// Every adoption statement joins through agents and filters internal = 0 (the operator's
// own fleet, migration 0026). The fake asserts that predicate is present: a statement that
// forgets it falls through to the empty default and the test fails loudly.

type Fixture = {
  totals?: Partial<Record<string, number>>;
  excluded?: Partial<Record<string, number>>;
  signups?: { d: string; n: number }[];
  posts?: { d: string; n: number }[];
  dm?: { d: string; n: number }[];
  healthAgents?: { last_posted_at: string | null }[];
  topAgents?: any[];
  recentSignups?: any[];
  recentPosts?: any[];
};

function resolveAll(sql: string, fx: Fixture): { results: any[] } {
  const one = (n: number | undefined) => ({ results: [{ n: n ?? 0 }] });

  // the `excluded` disclosure counts (internal = 1), matched before their internal = 0 twins
  if (/FROM agents WHERE internal = 1\s*$/.test(sql)) return one(fx.excluded?.internal_agents);
  if (/parent_id IS NULL AND a\.internal = 1/.test(sql)) return one(fx.excluded?.internal_posts);

  // scalar COUNTs (totals batch), all filtered to non-internal accounts
  if (/^\s*SELECT COUNT\(\*\) AS n FROM agents WHERE internal = 0\s*$/.test(sql)) return one(fx.totals?.agents);
  // anchored at end of statement so the grouped timeseries reads (same tables, plus a
  // GROUP BY tail) cannot be swallowed by a totals matcher
  if (/FROM dailies d JOIN agents a .*parent_id IS NULL AND a\.internal = 0\s*$/.test(sql)) return one(fx.totals?.dailies);
  if (/FROM follows f JOIN agents .*internal = 0 AND \w+\.internal = 0\s*$/.test(sql)) return one(fx.totals?.follows);
  if (/COUNT\(\*\) AS n FROM dm_log m JOIN agents a .*a\.internal = 0\s*$/.test(sql)) return one(fx.totals?.dm_questions);
  if (/FROM dailies d JOIN agents a .*parent_id IS NOT NULL AND a\.internal = 0\s*$/.test(sql)) return one(fx.totals?.comments);
  if (/FROM reactions r JOIN agents a .*a\.internal = 0\s*$/.test(sql)) return one(fx.totals?.likes);
  if (/FROM invites i JOIN agents a .*a\.internal = 0\s*$/.test(sql)) return one(fx.totals?.invites_used);

  // timeseries + lists
  if (/FROM agents WHERE internal = 0 GROUP BY d/.test(sql)) return { results: fx.signups ?? [] };
  if (/FROM dailies p JOIN agents a[\s\S]*internal = 0 GROUP BY d/.test(sql)) return { results: fx.posts ?? [] };
  if (/FROM dm_log m JOIN agents a .*internal = 0 GROUP BY d/.test(sql)) return { results: fx.dm ?? [] };
  if (/SELECT last_posted_at FROM agents WHERE internal = 0/.test(sql)) return { results: fx.healthAgents ?? [] };
  if (/FROM agents a LEFT JOIN dailies[\s\S]*WHERE a\.internal = 0/.test(sql)) return { results: fx.topAgents ?? [] };
  if (/FROM agents WHERE internal = 0 ORDER BY created_at DESC/.test(sql)) return { results: fx.recentSignups ?? [] };
  if (/FROM dailies d JOIN agents a[\s\S]*parent_id IS NULL AND a\.internal = 0[\s\S]*ORDER BY d\.created_at/.test(sql)) return { results: fx.recentPosts ?? [] };
  return { results: [] };
}

function fakeEnv(fx: Fixture, adminKey: string | undefined, extra: Record<string, unknown> = {}) {
  const DB: any = {
    prepare(sql: string) {
      const stmt: any = {
        bind() { return stmt; },
        async all<T>() { return resolveAll(sql, fx) as { results: T[] }; },
        async first<T>() { return (resolveAll(sql, fx).results[0] ?? null) as T | null; },
        _resolveAll() { return resolveAll(sql, fx); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return { DB, ADMIN_KEY: adminKey, ...extra } as any;
}

function call(env: any, opts: { key?: string; header?: string; access?: boolean } = {}) {
  const qs = opts.key != null ? "?key=" + encodeURIComponent(opts.key) : "";
  const headers: Record<string, string> = {};
  if (opts.header != null) headers["x-admin-key"] = opts.header;
  if (opts.access) headers["cf-access-jwt-assertion"] = "stub.jwt.token";
  const request = new Request("https://x/api/admin/stats" + qs, { headers });
  return onRequestGet({ env, request, params: {} } as any);
}

const SECRET = "s3cr3t-admin-key";

describe("GET /api/admin/stats gate", () => {
  test("401 when there is no key and no Access", async () => {
    const r = await call(fakeEnv({}, undefined));
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("unauthorized");
  });

  test("200 behind Cloudflare Access with no key", async () => {
    const r = await call(fakeEnv({ totals: { agents: 3 } }, undefined), { access: true });
    expect(r.status).toBe(200);
    expect((await r.json() as any).totals.agents).toBe(3);
  });

  test("401 with no key", async () => {
    const r = await call(fakeEnv({}, SECRET));
    expect(r.status).toBe(401);
    const b: any = await r.json();
    expect(b.code).toBe("unauthorized");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("401 with a wrong key", async () => {
    const r = await call(fakeEnv({}, SECRET), { key: "nope" });
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("unauthorized");
  });

  test("200 with the right key via query", async () => {
    const r = await call(fakeEnv({ totals: { agents: 3 } }, SECRET), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.totals.agents).toBe(3);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("200 with the right key via x-admin-key header", async () => {
    const r = await call(fakeEnv({}, SECRET), { header: SECRET });
    expect(r.status).toBe(200);
  });
});

describe("GET /api/admin/stats aggregations", () => {
  test("totals map every count and timeseries group by day", async () => {
    const fx: Fixture = {
      totals: {
        agents: 5, dailies: 40, follows: 7,
        dm_questions: 9, comments: 3, likes: 12, invites_used: 6,
      },
      signups: [
        { d: "2026-07-01", n: 2 },
        { d: "2026-07-02", n: 1 },
        { d: "2026-07-04", n: 2 },
      ],
      posts: [
        { d: "2026-07-01", n: 3 },
        { d: "2026-07-02", n: 5 },
      ],
      dm: [{ d: "2026-07-02", n: 4 }],
      healthAgents: [
        { last_posted_at: new Date().toISOString() },          // active
        { last_posted_at: "2020-01-01T00:00:00Z" },            // lapsed (old)
        { last_posted_at: null },                              // lapsed (never)
      ],
      topAgents: [{ handle: "alpha", posts: 20, followers: 3 }],
      recentSignups: [{ handle: "zed", created_at: "2026-07-04T10:00:00Z" }],
      recentPosts: [{ handle: "alpha", headline: "shipped it", body_md: null, date: "2026-07-04" }],
    };
    const r = await call(fakeEnv(fx, SECRET), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();

    expect(b.totals).toEqual({
      agents: 5, posts: 40, follows: 7,
      dm_questions: 9, comments: 3, likes: 12, invites_used: 6,
    });

    // signups series preserved, sorted asc
    expect(b.timeseries.signups).toEqual([
      { date: "2026-07-01", n: 2 },
      { date: "2026-07-02", n: 1 },
      { date: "2026-07-04", n: 2 },
    ]);
    // cumulative is the running sum
    expect(b.timeseries.members_cumulative).toEqual([
      { date: "2026-07-01", total: 2 },
      { date: "2026-07-02", total: 3 },
      { date: "2026-07-04", total: 5 },
    ]);
    expect(b.timeseries.posts).toEqual([
      { date: "2026-07-01", n: 3 },
      { date: "2026-07-02", n: 5 },
    ]);
    expect(b.timeseries.dm).toEqual([{ date: "2026-07-02", n: 4 }]);

    // health: 1 active, 2 lapsed
    expect(b.health).toEqual({ active: 1, lapsed: 2 });

    // top lists + recents shape
    expect(b.top_agents[0]).toEqual({ handle: "alpha", posts: 20, followers: 3 });
    expect(b.top_projects).toBeUndefined();
    expect(b.recent_signups[0]).toEqual({ handle: "zed", created_at: "2026-07-04T10:00:00Z" });
    expect(b.recent_posts[0]).toEqual({ handle: "alpha", headline: "shipped it", date: "2026-07-04" });
  });
});

describe("GET /api/admin/stats excludes the operator's own accounts", () => {
  // The fake only answers statements carrying `internal = 0`; the internal = 1 twins feed
  // the disclosure. So the numbers below ARE the post-exclusion numbers: 5 outside members
  // and 40 outside posts alongside 21 operator accounts and 300 of their posts.
  const fx: Fixture = {
    totals: { agents: 5, dailies: 40, follows: 7, dm_questions: 9, comments: 3, likes: 12, invites_used: 6 },
    excluded: { internal_agents: 21, internal_posts: 300 },
    signups: [{ d: "2026-07-01", n: 2 }, { d: "2026-07-02", n: 3 }],
    posts: [{ d: "2026-07-02", n: 4 }],
    healthAgents: [{ last_posted_at: new Date().toISOString() }, { last_posted_at: null }],
    topAgents: [{ handle: "alpha", posts: 4, followers: 1 }],
    recentSignups: [{ handle: "zed", created_at: "2026-07-02T10:00:00Z" }],
    recentPosts: [{ handle: "alpha", headline: "shipped it", body_md: null, date: "2026-07-02" }],
  };

  test("totals, timeseries, health and lists all come from internal = 0 reads", async () => {
    const r = await call(fakeEnv(fx, SECRET), { key: SECRET });
    const b: any = await r.json();
    // Every one of these is non-zero only because the filtered statement was the one issued.
    expect(b.totals.agents).toBe(5);
    expect(b.totals.posts).toBe(40);
    expect(b.totals.follows).toBe(7);
    expect(b.totals.dm_questions).toBe(9);
    expect(b.totals.comments).toBe(3);
    expect(b.totals.likes).toBe(12);
    expect(b.totals.invites_used).toBe(6);
    expect(b.timeseries.signups).toEqual([
      { date: "2026-07-01", n: 2 },
      { date: "2026-07-02", n: 3 },
    ]);
    expect(b.timeseries.posts).toEqual([{ date: "2026-07-02", n: 4 }]);
    expect(b.timeseries.members_cumulative.at(-1)).toEqual({ date: "2026-07-02", total: 5 });
    expect(b.health).toEqual({ active: 1, lapsed: 1 });
    expect(b.top_agents).toHaveLength(1);
    expect(b.recent_signups).toHaveLength(1);
    expect(b.recent_posts).toHaveLength(1);
  });

  test("the excluded disclosure reports what was left out", async () => {
    const r = await call(fakeEnv(fx, SECRET), { key: SECRET });
    const b: any = await r.json();
    expect(b.excluded).toEqual({ internal_agents: 21, internal_posts: 300 });
  });

  test("no exclusion reads as a zeroed disclosure, not a missing one", async () => {
    const r = await call(fakeEnv({ totals: { agents: 2 } }, SECRET), { key: SECRET });
    const b: any = await r.json();
    expect(b.excluded).toEqual({ internal_agents: 0, internal_posts: 0 });
  });
});

// ---- provider (DeepSeek) balance ------------------------------------------
const realFetch = globalThis.fetch;
function stubFetch(impl: (url: string, init: any) => any) {
  (globalThis as any).fetch = (url: any, init: any) => {
    const u = String(url);
    if (!u.includes("api.deepseek.com")) return realFetch(url, init);
    return Promise.resolve(impl(u, init)).then((v) => (v instanceof Error ? Promise.reject(v) : v));
  };
}
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const BAL_OK = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "14.00", granted_balance: "0", topped_up_balance: "14.00" },
    { currency: "USD", total_balance: "1.98", granted_balance: "0.00", topped_up_balance: "1.98" },
  ],
};

describe("GET /api/admin/stats provider balance", () => {
  afterEach(() => { (globalThis as any).fetch = realFetch; });

  test("shapes the USD balance and passes the key + an abort signal", async () => {
    let seen: any = null;
    stubFetch((u, init) => { seen = { u, init }; return jsonRes(BAL_OK); });
    const r = await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk-test" }), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.provider_balance).toEqual({
      ok: true,
      currency: "USD",
      total_balance: 1.98,
      granted_balance: 0,
      topped_up_balance: 1.98,
      is_available: true,
    });
    expect(seen.u).toBe("https://api.deepseek.com/user/balance");
    expect(seen.init.headers.Authorization).toBe("Bearer sk-test");
    expect(seen.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("is_available false is carried through", async () => {
    stubFetch(() => jsonRes({ ...BAL_OK, is_available: false }));
    const b: any = await (await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET })).json();
    expect(b.provider_balance.ok).toBe(true);
    expect(b.provider_balance.is_available).toBe(false);
  });

  test("no key configured -> ok:false, no fetch attempted", async () => {
    let called = false;
    stubFetch(() => { called = true; return jsonRes(BAL_OK); });
    const b: any = await (await call(fakeEnv({}, SECRET), { key: SECRET })).json();
    expect(b.provider_balance).toEqual({ ok: false, reason: "no_key" });
    expect(called).toBe(false);
  });

  test("a throwing fetch still returns 200 with the rest of the dashboard", async () => {
    stubFetch(() => new Error("network down"));
    const r = await call(fakeEnv({ totals: { agents: 4 } }, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.provider_balance).toEqual({ ok: false, reason: "fetch_failed" });
    expect(b.totals.agents).toBe(4);
    expect(b.ok).toBe(true);
  });

  test("an aborted (timed out) fetch reports reason timeout", async () => {
    stubFetch(() => Object.assign(new Error("aborted"), { name: "AbortError" }));
    const r = await call(fakeEnv({ totals: { agents: 4 } }, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.provider_balance).toEqual({ ok: false, reason: "timeout" });
    expect(b.totals.agents).toBe(4);
  });

  test("a non-200 and a malformed body both degrade to ok:false", async () => {
    stubFetch(() => jsonRes({ error: "nope" }, 401));
    let b: any = await (await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET })).json();
    expect(b.provider_balance).toEqual({ ok: false, reason: "http_401" });

    stubFetch(() => jsonRes({ hello: "world" }));
    b = await (await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET })).json();
    expect(b.provider_balance).toEqual({ ok: false, reason: "bad_shape" });

    stubFetch(() => new Response("not json", { status: 200 }));
    b = await (await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk" }), { key: SECRET })).json();
    expect(b.provider_balance.ok).toBe(false);
  });

  test("an unauthorized caller never triggers the balance call", async () => {
    let called = false;
    stubFetch(() => { called = true; return jsonRes(BAL_OK); });
    const r = await call(fakeEnv({}, SECRET, { DEEPSEEK_API_KEY: "sk" }));
    expect(r.status).toBe(401);
    expect(called).toBe(false);
  });
});
