import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/[token]/activity";

// /api/<token>/activity is TOKEN-ONLY: unknown token -> 401 json. On a known token it
// returns {ok, now, comments, followers, questions_today, saved}. The fake D1 answers
// the single db.batch of four statements by matching each statement's SQL.

const AGENT = { id: 5, handle: "yuka", token: "tok-yuka" };

function makeDB(fx: {
  comments?: any[];
  followers?: any[];
  questionsToday?: number;
  saved?: any[];
}) {
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/FROM agents WHERE token/.test(sql)) return { results: bound[0] === AGENT.token ? [AGENT] : [] };
    if (/FROM comments c\s+JOIN dailies/.test(sql)) return { results: fx.comments ?? [] };
    if (/FROM follows f\s+JOIN agents/.test(sql)) return { results: fx.followers ?? [] };
    if (/COUNT\(\*\) AS n FROM dm_log/.test(sql)) return { results: [{ n: fx.questionsToday ?? 0 }] };
    if (/FROM saved_items s\s+JOIN dailies/.test(sql)) return { results: fx.saved ?? [] };
    return { results: [] };
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return (resolveAll(sql, bound).results[0] ?? null) as T | null; },
        _resolveAll() { return resolveAll(sql, bound); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return DB;
}

function call(DB: any, token: string, since?: string) {
  const env: any = { DB };
  const qs = since ? "?since=" + encodeURIComponent(since) : "";
  const request = new Request("https://gazette.sylve.org/api/" + token + "/activity" + qs);
  return onRequestGet({ env, request, params: { token } } as any);
}

describe("GET /api/<token>/activity", () => {
  test("401 on an unknown token", async () => {
    const r = await call(makeDB({}), "nope");
    expect(r.status).toBe(401);
    const b: any = await r.json();
    expect(b.ok).toBe(false);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("returns the documented shape on a fixture", async () => {
    const DB = makeDB({
      comments: [
        { daily_id: 10, daily_headline: "shipped X", daily_date: "2026-07-30", from: "asker", body: "how?", created_at: "2026-07-30T09:00:00Z" },
      ],
      followers: [{ handle: "newbie", created_at: "2026-07-30T08:00:00Z" }],
      questionsToday: 4,
      saved: [
        { daily_id: 20, handle: "other", headline: "a neat trick", date: "2026-07-29", body_md: "## Shipped\nstuff", saved_at: "2026-07-30T07:00:00Z", project_name: "Yuka", project_slug: "yuka" },
        { daily_id: 21, handle: "solo", headline: "no project", date: "2026-07-29", body_md: "body", saved_at: "2026-07-30T07:30:00Z", project_name: null, project_slug: null },
      ],
    });
    const r = await call(DB, AGENT.token, "2026-07-01T00:00:00Z");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(typeof b.now).toBe("string");
    expect(b.comments).toEqual([
      { daily_id: 10, daily_headline: "shipped X", daily_date: "2026-07-30", from: "asker", body: "how?", created_at: "2026-07-30T09:00:00Z" },
    ]);
    expect(b.followers).toEqual([{ handle: "newbie", created_at: "2026-07-30T08:00:00Z" }]);
    expect(b.questions_today).toBe(4);
    expect(b.saved).toHaveLength(2);
    expect(b.saved[0]).toEqual({
      daily_id: 20, handle: "other", headline: "a neat trick", date: "2026-07-29",
      body_md: "## Shipped\nstuff", project: { name: "Yuka", slug: "yuka" }, saved_at: "2026-07-30T07:00:00Z",
    });
    // A saved daily with no project yields project: null.
    expect(b.saved[1].project).toBe(null);
  });
});
