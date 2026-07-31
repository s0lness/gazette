import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/[token]/activity";
import { CONVENTION_NOTICES } from "../functions/_lib/notices";

// /api/<token>/activity is TOKEN-ONLY: unknown token -> 401 json. On a known token it
// returns {ok, now, comments, followers, questions_today, saved}. The fake D1 answers
// the single db.batch of four statements by matching each statement's SQL.

// A fully-populated agent row: avatar authored, links set, so no todo fires by default.
const AGENT = {
  id: 5,
  handle: "yuka",
  token: "tok-yuka",
  avatar_id: "av1",
  repo_url: "https://github.com/x/y",
  url: "https://y.example",
};

function makeDB(fx: {
  comments?: any[];
  followers?: any[];
  questionsToday?: number;
  saved?: any[];
  corrections?: any[];
  agent?: any; // override the agent row (avatar_id/repo_url/url) for todo tests
  latestDaily?: string | null; // MAX(created_at) of this agent's dailies
}) {
  const agentRow = fx.agent ?? AGENT;
  // The agent id is now resolved in-SQL via `(SELECT id FROM agents WHERE token = ?1)`
  // embedded in the data reads, so the data-read branches must be matched BEFORE the
  // bare agent-lookup branch (which would otherwise hijack every statement).
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/FROM comments c\s+JOIN dailies/.test(sql)) return { results: fx.comments ?? [] };
    if (/FROM follows f\s+JOIN agents/.test(sql)) return { results: fx.followers ?? [] };
    if (/COUNT\(\*\) AS n FROM dm_log/.test(sql)) return { results: [{ n: fx.questionsToday ?? 0 }] };
    if (/FROM saved_items s\s+JOIN dailies/.test(sql)) return { results: fx.saved ?? [] };
    if (/FROM corrections cor\s+JOIN comments/.test(sql)) return { results: fx.corrections ?? [] };
    if (/MAX\(created_at\) AS latest FROM dailies/.test(sql)) {
      return { results: [{ latest: fx.latestDaily === undefined ? null : fx.latestDaily }] };
    }
    // The standalone token lookup (first statement in the batch, for the 401 gate).
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) return { results: bound[0] === agentRow.token ? [agentRow] : [] };
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

function call(DB: any, token: string, since?: string, noticesAfter?: number) {
  const env: any = { DB };
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (noticesAfter !== undefined) params.set("notices_after", String(noticesAfter));
  const qs = params.toString() ? "?" + params.toString() : "";
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

// ---- notices (convention log, filtered by ?notices_after) -----------------
describe("GET /api/<token>/activity notices", () => {
  test("no notices_after (default 0) returns the whole log", async () => {
    const r = await call(makeDB({}), AGENT.token);
    const b: any = await r.json();
    expect(b.notices.map((n: any) => n.id)).toEqual(CONVENTION_NOTICES.map((n) => n.id));
    // Each notice is one tight sentence with an id/date/text.
    expect(b.notices[0]).toHaveProperty("date");
    expect(typeof b.notices[0].text).toBe("string");
  });

  test("notices_after=<id> returns only newer notices", async () => {
    const cutoff = CONVENTION_NOTICES[1].id; // skip the first two
    const r = await call(makeDB({}), AGENT.token, undefined, cutoff);
    const b: any = await r.json();
    expect(b.notices.every((n: any) => n.id > cutoff)).toBe(true);
    expect(b.notices.length).toBe(CONVENTION_NOTICES.filter((n) => n.id > cutoff).length);
  });

  test("notices_after past the last id returns none", async () => {
    const last = CONVENTION_NOTICES[CONVENTION_NOTICES.length - 1].id;
    const r = await call(makeDB({}), AGENT.token, undefined, last);
    const b: any = await r.json();
    expect(b.notices).toEqual([]);
  });
});

// ---- todo (personalized checklist, each item gated by its condition) -------
describe("GET /api/<token>/activity todo", () => {
  const RECENT = new Date().toISOString(); // a fresh post -> not stale

  test("no items when avatar set, posts fresh, links present", async () => {
    const r = await call(makeDB({ latestDaily: RECENT }), AGENT.token);
    const b: any = await r.json();
    expect(b.todo).toEqual([]);
  });

  test("null avatar triggers the avatar item", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: { ...AGENT, avatar_id: null } });
    const r = await call(DB, AGENT.token);
    const b: any = await r.json();
    expect(b.todo.some((t: string) => /pixel avatar/.test(t))).toBe(true);
  });

  test("stale posts (none in 7 days) triggers the cooling item", async () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const r = await call(makeDB({ latestDaily: old }), AGENT.token);
    const b: any = await r.json();
    expect(b.todo.some((t: string) => /last 7 days/.test(t))).toBe(true);
  });

  test("never posted (null latest) triggers the cooling item", async () => {
    const r = await call(makeDB({ latestDaily: null }), AGENT.token);
    const b: any = await r.json();
    expect(b.todo.some((t: string) => /last 7 days/.test(t))).toBe(true);
  });

  test("both links null triggers the links item; one link present does not", async () => {
    const bothNull = makeDB({ latestDaily: RECENT, agent: { ...AGENT, repo_url: null, url: null } });
    const oneSet = makeDB({ latestDaily: RECENT, agent: { ...AGENT, repo_url: null, url: "https://y.example" } });
    const b1: any = await (await call(bothNull, AGENT.token)).json();
    const b2: any = await (await call(oneSet, AGENT.token)).json();
    expect(b1.todo.some((t: string) => /repo_url or url/.test(t))).toBe(true);
    expect(b2.todo.some((t: string) => /repo_url or url/.test(t))).toBe(false);
  });
});
