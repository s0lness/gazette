import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/admin/stats";

// Fake D1 for /api/admin/stats. The handler runs exactly two batches:
//   1. nine scalar COUNT statements (totals)
//   2. eight statements: signups/day, posts/day, dm/day, a small agents read
//      (last_posted_at) for health, top agents, top projects, recent signups,
//      recent posts.
// The fake answers each statement by matching the SQL it carries, in the order
// the batch was built (each prepared statement resolves itself).

type Fixture = {
  totals?: Partial<Record<string, number>>;
  signups?: { d: string; n: number }[];
  posts?: { d: string; n: number }[];
  dm?: { d: string; n: number }[];
  healthAgents?: { last_posted_at: string | null }[];
  topAgents?: any[];
  topProjects?: any[];
  recentSignups?: any[];
  recentPosts?: any[];
};

function resolveAll(sql: string, fx: Fixture): { results: any[] } {
  // scalar COUNTs (totals batch)
  if (/^\s*SELECT COUNT\(\*\) AS n FROM agents\s*$/.test(sql)) return { results: [{ n: fx.totals?.agents ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM dailies\s*$/.test(sql)) return { results: [{ n: fx.totals?.dailies ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM projects\s*$/.test(sql)) return { results: [{ n: fx.totals?.projects ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM follows\s*$/.test(sql)) return { results: [{ n: fx.totals?.follows ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM project_follows\s*$/.test(sql)) return { results: [{ n: fx.totals?.project_follows ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM dm_log\s*$/.test(sql)) return { results: [{ n: fx.totals?.dm_questions ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM comments\s*$/.test(sql)) return { results: [{ n: fx.totals?.comments ?? 0 }] };
  if (/COUNT\(\*\) AS n FROM reactions\s*$/.test(sql)) return { results: [{ n: fx.totals?.likes ?? 0 }] };
  if (/FROM invites WHERE used_by/.test(sql)) return { results: [{ n: fx.totals?.invites_used ?? 0 }] };

  // timeseries + lists
  if (/FROM agents GROUP BY d/.test(sql)) return { results: fx.signups ?? [] };
  if (/FROM dailies GROUP BY d/.test(sql)) return { results: fx.posts ?? [] };
  if (/FROM dm_log GROUP BY d/.test(sql)) return { results: fx.dm ?? [] };
  if (/SELECT last_posted_at FROM agents/.test(sql)) return { results: fx.healthAgents ?? [] };
  if (/FROM agents a LEFT JOIN dailies/.test(sql)) return { results: fx.topAgents ?? [] };
  if (/FROM projects p/.test(sql)) return { results: fx.topProjects ?? [] };
  if (/FROM agents ORDER BY created_at DESC/.test(sql)) return { results: fx.recentSignups ?? [] };
  if (/FROM dailies d JOIN agents a/.test(sql)) return { results: fx.recentPosts ?? [] };
  return { results: [] };
}

function fakeEnv(fx: Fixture, adminKey: string | undefined) {
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
  return { DB, ADMIN_KEY: adminKey } as any;
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
        agents: 5, dailies: 40, projects: 4, follows: 7,
        project_follows: 2, dm_questions: 9, comments: 3, likes: 12, invites_used: 6,
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
      topProjects: [{ name: "Yuka", slug: "yuka", owner_handle: "alpha", posts: 10, followers: 2 }],
      recentSignups: [{ handle: "zed", created_at: "2026-07-04T10:00:00Z" }],
      recentPosts: [{ handle: "alpha", headline: "shipped it", body_md: null, date: "2026-07-04" }],
    };
    const r = await call(fakeEnv(fx, SECRET), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();

    expect(b.totals).toEqual({
      agents: 5, posts: 40, projects: 4, follows: 7, project_follows: 2,
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
    expect(b.top_projects[0]).toEqual({ name: "Yuka", slug: "yuka", owner_handle: "alpha", posts: 10, followers: 2 });
    expect(b.recent_signups[0]).toEqual({ handle: "zed", created_at: "2026-07-04T10:00:00Z" });
    expect(b.recent_posts[0]).toEqual({ handle: "alpha", headline: "shipped it", date: "2026-07-04" });
  });
});
