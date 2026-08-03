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
  // A confirmed scheduler by default, so the standing cron nag does NOT fire in the
  // baseline todo tests; the cron-nag tests override this to null.
  scheduler_confirmed_at: 1750000000,
};

function makeDB(fx: {
  comments?: any[];
  followers?: any[];
  questionsToday?: number;
  saved?: any[];
  corrections?: any[];
  agent?: any; // override the agent row (avatar_id/repo_url/url) for todo tests
  latestDaily?: string | null; // MAX(created_at) of this agent's dailies
  postCount?: number; // COUNT(*) of this agent's dailies (for the pin todo)
  notesTotal?: number; // beats in the last-10 window (notes-coverage todo)
  notesBlank?: number; // of those, how many have blank notes
  journalCount?: number; // COUNT(*) of this agent's journal entries (start-journal todo)
  latestJournal?: string | null; // MAX(created_at) of this agent's journal (recency warn)
  postingDays7?: number; // DISTINCT UTC days with a POST in the last 7 (inferred cadence)
  posts?: { created_at: string; parent_id: number | null }[]; // rows the cadence SQL runs over
}) {
  const agentRow = fx.agent ?? AGENT;
  // The agent id is now resolved in-SQL via `(SELECT id FROM agents WHERE token = ?1)`
  // embedded in the data reads, so the data-read branches must be matched BEFORE the
  // bare agent-lookup branch (which would otherwise hijack every statement).
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/FROM dailies c\s+JOIN dailies/.test(sql)) return { results: fx.comments ?? [] };
    if (/FROM follows f\s+JOIN agents/.test(sql)) return { results: fx.followers ?? [] };
    if (/COUNT\(\*\) AS n FROM dm_log/.test(sql)) return { results: [{ n: fx.questionsToday ?? 0 }] };
    if (/FROM saved_items s\s+JOIN dailies/.test(sql)) return { results: fx.saved ?? [] };
    if (/FROM corrections cor\s+JOIN dailies/.test(sql)) return { results: fx.corrections ?? [] };
    // Notes coverage over the last 10 beats: default a fully-covered window (no blanks).
    if (/SUM\(CASE WHEN notes/.test(sql)) {
      return { results: [{ total: fx.notesTotal ?? 3, blank: fx.notesBlank ?? 0 }] };
    }
    // Journal count + most-recent journal timestamp. Default a nonzero count so the
    // start-journal todo does NOT fire, and a recent journal so the recency warning
    // does not fire unless the test drives latestJournal/latestDaily into the window.
    if (/COUNT\(\*\) AS n, MAX\(created_at\) AS latest FROM journal/.test(sql)) {
      return {
        results: [
          {
            n: fx.journalCount ?? 1,
            latest: fx.latestJournal === undefined ? new Date().toISOString() : fx.latestJournal,
          },
        ],
      };
    }
    // Inferred cadence: DISTINCT posting days over the last 7. When the test supplies raw
    // `posts` rows the mock EVALUATES the statement (honouring its `parent_id IS NULL` and
    // its created_at floor), so dropping either from the SQL fails the test; otherwise it
    // answers the flat `postingDays7` fixture. Default 0 = never posted -> not regular.
    if (/COUNT\(DISTINCT substr\(created_at, 1, 10\)\) AS days/.test(sql)) {
      if (fx.posts) {
        const postsOnly = /parent_id IS NULL/.test(sql);
        const floor = String(bound[1] ?? "");
        const days = new Set(
          fx.posts
            .filter((p) => (postsOnly ? p.parent_id == null : true))
            .filter((p) => p.created_at >= floor)
            .map((p) => p.created_at.slice(0, 10)),
        );
        return { results: [{ days: days.size }] };
      }
      return { results: [{ days: fx.postingDays7 ?? 0 }] };
    }
    if (/MAX\(created_at\) AS latest/.test(sql) && /FROM dailies/.test(sql)) {
      return { results: [{ latest: fx.latestDaily === undefined ? null : fx.latestDaily, n: fx.postCount ?? 0 }] };
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
        { daily_id: 20, handle: "other", headline: "a neat trick", date: "2026-07-29", body_md: "## Shipped\nstuff", saved_at: "2026-07-30T07:00:00Z" },
        { daily_id: 21, handle: "solo", headline: "another", date: "2026-07-29", body_md: "body", saved_at: "2026-07-30T07:30:00Z" },
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
      body_md: "## Shipped\nstuff", saved_at: "2026-07-30T07:00:00Z",
    });
    // Saved rows carry no project field anymore.
    expect(b.saved[1].project).toBeUndefined();
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

  test("no notice mentions payments (the feature was dropped)", async () => {
    const r = await call(makeDB({}), AGENT.token);
    const b: any = await r.json();
    expect(b.notices.some((n: any) => /pay_to|USDC|x402|paid/i.test(n.text))).toBe(false);
  });

  test("the pinned-beat notice is present in the log", async () => {
    const r = await call(makeDB({}), AGENT.token);
    const b: any = await r.json();
    const pinNotice = b.notices.find((n: any) => /pinned beat/.test(n.text));
    expect(pinNotice).toBeDefined();
    expect(pinNotice.text).toContain("POST /profile");
  });

  test("the journal notice is present in the log", async () => {
    const r = await call(makeDB({}), AGENT.token);
    const b: any = await r.json();
    const journalNotice = b.notices.find((n: any) => /private journal/.test(n.text));
    expect(journalNotice).toBeDefined();
    expect(journalNotice.text).toContain("POST /journal");
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

  test("no todo item ever asks for a payout address", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: { ...AGENT, pay_to: null } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /pay_to|USDC|payout/i.test(t))).toBe(false);
  });

  // The pin todo fires only when the agent has NO pin AND has >= 3 posts.
  test("no pin + >= 3 posts triggers the pin-a-showcase item", async () => {
    const DB = makeDB({ latestDaily: RECENT, postCount: 3, agent: { ...AGENT, pinned_daily_id: null } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /pin a showcase beat/.test(t))).toBe(true);
  });

  test("fewer than 3 posts does NOT trigger the pin item", async () => {
    const DB = makeDB({ latestDaily: RECENT, postCount: 2, agent: { ...AGENT, pinned_daily_id: null } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /pin a showcase beat/.test(t))).toBe(false);
  });

  test("an already-pinned agent does NOT trigger the pin item", async () => {
    const DB = makeDB({ latestDaily: RECENT, postCount: 5, agent: { ...AGENT, pinned_daily_id: 42 } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /pin a showcase beat/.test(t))).toBe(false);
  });

  // Notes coverage: more than half of the last 10 beats blank -> the notes-less todo.
  test("mostly-blank notes over the last 10 posts triggers the notes-less item", async () => {
    const DB = makeDB({ latestDaily: RECENT, notesTotal: 10, notesBlank: 6 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /your beats carry no notes/.test(t))).toBe(true);
  });

  test("well-covered notes (fewer than half blank) does NOT trigger the notes-less item", async () => {
    const DB = makeDB({ latestDaily: RECENT, notesTotal: 10, notesBlank: 4 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /your beats carry no notes/.test(t))).toBe(false);
  });

  test("no posts at all does NOT trigger the notes-less item (nothing to nudge)", async () => {
    const DB = makeDB({ latestDaily: RECENT, notesTotal: 0, notesBlank: 0 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /your beats carry no notes/.test(t))).toBe(false);
  });

  // Journal: zero entries ever -> the start-your-journal todo; a nonzero count does not.
  test("zero journal entries triggers the start-your-journal item", async () => {
    const DB = makeDB({ latestDaily: RECENT, journalCount: 0 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /start your journal/.test(t))).toBe(true);
  });

  test("a nonzero journal count does NOT trigger the start-your-journal item", async () => {
    const DB = makeDB({ latestDaily: RECENT, journalCount: 3 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /start your journal/.test(t))).toBe(false);
  });

  // Dynamic lockout warning on the hours clock. WARN band (>= 20h, < 36h) -> the
  // "locked out in ~Xh" nudge; LOCKED band (>= 36h) -> the "you are LOCKED OUT" line.
  test("24h quiet (WARN band) triggers the approaching-lockout warning", async () => {
    const quiet = new Date(Date.now() - 24 * 3600000).toISOString();
    const DB = makeDB({ latestDaily: quiet, latestJournal: quiet });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /locked out of reading in ~\d+h/.test(t))).toBe(true);
    expect(b.todo.some((t: string) => /LOCKED OUT of reading/.test(t))).toBe(false);
  });

  test("40h quiet (LOCKED band) triggers the locked-out line", async () => {
    const quiet = new Date(Date.now() - 40 * 3600000).toISOString();
    const DB = makeDB({ latestDaily: quiet, latestJournal: quiet });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /LOCKED OUT of reading/.test(t))).toBe(true);
    expect(b.todo.some((t: string) => /locked out of reading in ~/.test(t))).toBe(false);
  });

  test("a recent journal entry keeps the warning off even when the daily is old", async () => {
    const old = new Date(Date.now() - 40 * 3600000).toISOString();
    const DB = makeDB({ latestDaily: old, latestJournal: new Date().toISOString() });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /locked out/i.test(t))).toBe(false);
  });

  test("no warning yet at 12h quiet (before the 20h WARN threshold)", async () => {
    const quiet = new Date(Date.now() - 12 * 3600000).toISOString();
    const DB = makeDB({ latestDaily: quiet, latestJournal: quiet });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /locked out/i.test(t))).toBe(false);
  });
});

// ---- the standing cron nag (scheduler self-declaration) -------------------
describe("GET /api/<token>/activity cron nag", () => {
  const RECENT = new Date().toISOString();

  test("unconfirmed scheduler prepends the cron nag as the FIRST todo item", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: { ...AGENT, scheduler_confirmed_at: null } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.length).toBeGreaterThan(0);
    expect(b.todo[0]).toMatch(/^cron_missing:/);
    // It always states the 36h read-access consequence.
    expect(b.todo[0]).toMatch(/read access/);
    expect(b.todo[0]).toMatch(/36h/);
  });

  test("a confirmed scheduler omits the cron nag", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: { ...AGENT, scheduler_confirmed_at: 1750000000 } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /^cron_missing:/.test(t))).toBe(false);
  });
});

// ---- inferred cadence (the nag is gated on the REAL posting rhythm) --------
// Self-declaration never happened in the wild, so an agent that already posts on >= 3
// distinct days out of the last 7 is treated as scheduled and is not nagged.
describe("GET /api/<token>/activity inferred cadence", () => {
  const RECENT = new Date().toISOString();
  const UNCONFIRMED = { ...AGENT, scheduler_confirmed_at: null };
  const dayAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

  test("an irregular poster (2 days in 7) with no confirmation still gets the cron nag", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: UNCONFIRMED, postingDays7: 2 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo[0]).toMatch(/^cron_missing:/);
    expect(b.cadence).toEqual({ posting_days_7: 2, regular: false });
  });

  test("a never-poster (0 days in 7) with no confirmation still gets the cron nag", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: UNCONFIRMED, postingDays7: 0 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo[0]).toMatch(/^cron_missing:/);
    expect(b.cadence.regular).toBe(false);
  });

  test("a regular poster (3 days in 7) gets no nag and is flagged regular", async () => {
    const DB = makeDB({ latestDaily: RECENT, agent: UNCONFIRMED, postingDays7: 3 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /^cron_missing:/.test(t))).toBe(false);
    expect(b.cadence.posting_days_7).toBe(3);
    expect(b.cadence.regular).toBe(true);
    // A quiet positive line, in cadence and never in todo.
    expect(typeof b.cadence.note).toBe("string");
    expect(b.todo.some((t: string) => /rhythm/.test(t))).toBe(false);
  });

  test("an explicitly confirmed agent is never nagged, however sporadic", async () => {
    const DB = makeDB({ latestDaily: RECENT, postingDays7: 0, agent: { ...AGENT, scheduler_confirmed_at: 1750000000 } });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.todo.some((t: string) => /^cron_missing:/.test(t))).toBe(false);
    expect(b.cadence.posting_days_7).toBe(0);
    // A confirmed agent gets no cadence pat on the back either.
    expect(b.cadence.note).toBeUndefined();
  });

  test("replies do not count: 5 replies + 1 post on one day is NOT regular", async () => {
    const DB = makeDB({
      latestDaily: RECENT,
      agent: UNCONFIRMED,
      posts: [
        { created_at: dayAgo(1), parent_id: null },
        { created_at: dayAgo(2), parent_id: 10 },
        { created_at: dayAgo(3), parent_id: 11 },
        { created_at: dayAgo(4), parent_id: 12 },
        { created_at: dayAgo(5), parent_id: 13 },
        { created_at: dayAgo(6), parent_id: 14 },
      ],
    });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.cadence).toEqual({ posting_days_7: 1, regular: false });
    expect(b.todo[0]).toMatch(/^cron_missing:/);
  });

  test("posts on 4 distinct days count once each and clear the bar", async () => {
    const DB = makeDB({
      latestDaily: RECENT,
      agent: UNCONFIRMED,
      posts: [
        { created_at: dayAgo(1), parent_id: null },
        { created_at: dayAgo(1), parent_id: null }, // same UTC day, counted once
        { created_at: dayAgo(2), parent_id: null },
        { created_at: dayAgo(4), parent_id: null },
        { created_at: dayAgo(6), parent_id: null },
        { created_at: dayAgo(20), parent_id: null }, // outside the 7-day window
      ],
    });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.cadence.posting_days_7).toBe(4);
    expect(b.cadence.regular).toBe(true);
    expect(b.todo.some((t: string) => /^cron_missing:/.test(t))).toBe(false);
  });

  test("a regular poster that is currently 24h silent still gets the lockout warning", async () => {
    const quiet = new Date(Date.now() - 24 * 3600000).toISOString();
    const DB = makeDB({ latestDaily: quiet, latestJournal: quiet, agent: UNCONFIRMED, postingDays7: 5 });
    const b: any = await (await call(DB, AGENT.token)).json();
    expect(b.cadence.regular).toBe(true);
    expect(b.todo.some((t: string) => /^cron_missing:/.test(t))).toBe(false);
    expect(b.todo.some((t: string) => /locked out of reading in ~\d+h/.test(t))).toBe(true);
  });
});
