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
  corrections?: any[];
}) {
  // The agent id is now resolved in-SQL via `(SELECT id FROM agents WHERE token = ?1)`
  // embedded in the data reads, so the data-read branches must be matched BEFORE the
  // bare agent-lookup branch (which would otherwise hijack every statement).
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/FROM comments c\s+JOIN dailies/.test(sql)) return { results: fx.comments ?? [] };
    if (/FROM follows f\s+JOIN agents/.test(sql)) return { results: fx.followers ?? [] };
    if (/COUNT\(\*\) AS n FROM dm_log/.test(sql)) return { results: [{ n: fx.questionsToday ?? 0 }] };
    if (/FROM saved_items s\s+JOIN dailies/.test(sql)) return { results: fx.saved ?? [] };
    if (/FROM corrections cor\s+JOIN comments/.test(sql)) return { results: fx.corrections ?? [] };
    // The standalone token lookup (first statement in the batch, for the 401 gate).
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) return { results: bound[0] === AGENT.token ? [AGENT] : [] };
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
        { daily_id: 10, daily_headline: "shipped X", daily_date: "2026-07-30", from: "asker", body: "how?", created_at: "2026-07-30T09:00:00Z", answered: 0 },
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
      { daily_id: 10, daily_headline: "shipped X", daily_date: "2026-07-30", from: "asker", body: "how?", created_at: "2026-07-30T09:00:00Z", answered: false },
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
    // corrections defaults to [] when none are flagged.
    expect(b.corrections).toEqual([]);
  });

  test("comments carry the answered flag (true when already handled)", async () => {
    const DB = makeDB({
      comments: [
        { daily_id: 10, daily_headline: "a", daily_date: "2026-07-30", from: "x", body: "q1", created_at: "2026-07-30T09:00:00Z", answered: 1 },
        { daily_id: 11, daily_headline: "b", daily_date: "2026-07-30", from: "y", body: "q2", created_at: "2026-07-30T10:00:00Z", answered: 0 },
      ],
    });
    const r = await call(DB, AGENT.token);
    const b: any = await r.json();
    expect(b.comments.map((c: any) => c.answered)).toEqual([true, false]);
  });

  test("carries the agent's unresolved corrections", async () => {
    const DB = makeDB({
      corrections: [
        { id: 1, comment_id: 100, daily_id: 10, comment_body: "flagged", note: "fix", created_at: "2026-07-30T10:00:00Z" },
      ],
    });
    const r = await call(DB, AGENT.token);
    const b: any = await r.json();
    expect(b.corrections).toEqual([
      { id: 1, comment_id: 100, daily_id: 10, comment_body: "flagged", note: "fix", created_at: "2026-07-30T10:00:00Z" },
    ]);
  });
});
