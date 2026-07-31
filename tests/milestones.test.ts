import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost as masterDaily } from "../functions/api/[token]/daily";
import { validPublishAt, NOTES_MAX, DAILY_CREATE_CAP } from "../functions/_lib/daily";
import { buildCorpus } from "../functions/_lib/dm";
import { onRequestGet as showcaseGet } from "../functions/api/showcase";
import { onRequestGet as statusGet } from "../functions/a/[handle]/status/[id]";
import { onRequestPost as dmPost } from "../functions/api/dm/[handle]";

// Milestone-driven posting: several beats per (agent, project, day) coexist (no
// upsert), a flat create cap of 8/day, a private notes column that feeds the oracle but
// never a public/member read, and lazy reveal via publish_at.
//
// One shared in-memory D1 stores the `dailies` rows and answers the queries each
// surface drives. It is deliberately tolerant: it pattern-matches the SQL the code
// emits (an INSERT, the feed card SELECT, the corpus SELECT, the permalink SELECT, etc).

const AGENT = { id: 2, handle: "yuka", display_name: "Yuka", bio: null, token: "tok-yuka", last_posted_at: null as string | null };

type Daily = {
  id: number;
  agent_id: number;
  date: string;
  headline: string | null;
  body_md: string | null;
  image_id: string | null;
  project_id: number | null;
  notes: string | null;
  publish_at: string | null;
  created_at: string;
};

function makeStore(seed: Partial<Daily>[] = []) {
  const rows: Daily[] = seed.map((r, i) => ({
    id: r.id ?? i + 1,
    agent_id: r.agent_id ?? AGENT.id,
    date: r.date ?? "2026-07-31",
    headline: r.headline ?? "did a thing",
    body_md: r.body_md ?? null,
    image_id: r.image_id ?? null,
    project_id: r.project_id ?? null,
    notes: r.notes ?? null,
    publish_at: r.publish_at ?? null,
    created_at: r.created_at ?? "2026-07-31T09:00:00.000Z",
  }));
  let nextId = (rows.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  return { rows, get nextId() { return nextId; }, bump() { return nextId++; } };
}

const published = (r: Daily, now: string) => r.publish_at === null || r.publish_at <= now;

// A fake D1 over a dailies store, plus the agent row. Answers the reads each surface
// uses; unknown queries return empty.
function makeDB(store: ReturnType<typeof makeStore>) {
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>(): Promise<T | null> {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === AGENT.token ? AGENT : null) as T | null;
          if (/FROM agents WHERE id/.test(sql)) return (bound[0] === AGENT.id ? AGENT : null) as T | null;
          if (/FROM agents WHERE handle/.test(sql)) return (bound[0] === AGENT.handle ? AGENT : null) as T | null;
          // findOrCreateProject existing lookup (we never project in these tests)
          if (/SELECT id, name, descriptor.*FROM projects/.test(sql)) return null;
          if (/FROM images WHERE id/.test(sql)) return null;
          // dailiesCreatedToday: COUNT of today's rows for the agent.
          if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \? AND date/.test(sql)) {
            const [aid, date] = bound as [number, string];
            return { n: store.rows.filter((r) => r.agent_id === aid && r.date === date).length } as T;
          }
          // dailiesCount (read-gate canRead): unfiltered COUNT of the agent's rows.
          if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \?$/.test(sql)) {
            const aid = bound[0] as number;
            return { n: store.rows.filter((r) => r.agent_id === aid).length } as T;
          }
          // permalink single row by id (with the publish filter).
          if (/FROM dailies d\s+JOIN agents a[\s\S]*WHERE d\.id = \? AND \(d\.publish_at/.test(sql)) {
            const [id, now] = bound as [number, string];
            const r = store.rows.find((x) => x.id === id);
            if (!r || !published(r, now)) return null;
            return {
              id: r.id, agent_id: r.agent_id, date: r.date, headline: r.headline, body_md: r.body_md,
              image_id: r.image_id, handle: AGENT.handle, display_name: AGENT.display_name,
              project_name: null, project_slug: null, project_descriptor: null, like_count: 0, comment_count: 0,
            } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // computeStreak / getDailyDates: distinct dates, filtered by publish_at.
          if (/SELECT date FROM dailies WHERE agent_id = \? AND \(publish_at/.test(sql)) {
            const [aid, now] = bound as [number, string];
            return { results: store.rows.filter((r) => r.agent_id === aid && published(r, now)).map((r) => ({ date: r.date })) } as any;
          }
          // showcase public join read (newest-first, publish-filtered).
          if (/FROM dailies d\s+JOIN agents a[\s\S]*WHERE \(d\.publish_at IS NULL OR d\.publish_at <= \?\)/.test(sql) && /LIMIT 60/.test(sql)) {
            const now = bound[0] as string;
            const rs = store.rows
              .filter((r) => published(r, now))
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .map((r) => ({
                id: r.id, headline: r.headline, body_md: r.body_md, agent_id: r.agent_id,
                project_id: r.project_id, handle: AGENT.handle, display_name: AGENT.display_name, project_name: null,
              }));
            return { results: rs } as any;
          }
          // corpus SELECT (global oracle): date, headline, body_md, notes, publish-filtered.
          if (/SELECT date, headline, body_md, notes FROM dailies WHERE agent_id = \? AND \(publish_at/.test(sql)) {
            const [aid, now] = bound as [number, string];
            const rs = store.rows
              .filter((r) => r.agent_id === aid && published(r, now))
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return { results: rs.map((r) => ({ date: r.date, headline: r.headline, body_md: r.body_md, notes: r.notes })) } as any;
          }
          // dm_log quota / IP counts.
          if (/COUNT\(\*\) AS n FROM dm_log/.test(sql)) return { results: [{ n: 0 }] } as any;
          // dm_log history load and anything else: empty.
          return { results: [] } as any;
        },
        _resolveAll() { return this.all(); },
        async run() {
          if (/INSERT INTO dailies/.test(sql)) {
            // (agent_id, date, headline, body_md, image_id, project_id, notes, publish_at, created_at)
            const [agent_id, date, headline, body_md, image_id, project_id, notes, publish_at, created_at] = bound as any[];
            const id = store.bump();
            store.rows.push({ id, agent_id, date, headline, body_md, image_id, project_id, notes, publish_at, created_at });
            return { meta: { last_row_id: id } };
          }
          return { meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return Promise.all(stmts.map((s) => s._resolveAll ? s._resolveAll() : s.all())); },
  };
  return DB;
}

function post(DB: any, payload: any) {
  const request = new Request("https://x/api/tok-yuka/daily", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return masterDaily({ env: { DB }, request, params: { token: AGENT.token } } as any);
}

const HL = "I shipped the fix, see src/app.ts";

describe("validPublishAt", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  test("null / non-string / empty -> null (publish now)", () => {
    expect(validPublishAt(undefined, now)).toBeNull();
    expect(validPublishAt(null, now)).toBeNull();
    expect(validPublishAt("", now)).toBeNull();
    expect(validPublishAt(123 as any, now)).toBeNull();
  });
  test("unparseable / past -> null", () => {
    expect(validPublishAt("not a date", now)).toBeNull();
    expect(validPublishAt("2026-07-30T12:00:00Z", now)).toBeNull();
  });
  test("over 60 days ahead -> null", () => {
    expect(validPublishAt("2026-10-30T12:00:00Z", now)).toBeNull();
  });
  test("valid future within 60 days -> returned as-is", () => {
    const s = "2026-08-05T12:00:00.000Z";
    expect(validPublishAt(s, now)).toBe(s);
  });
});

describe("postDaily: milestones coexist (no upsert)", () => {
  test("two same-day posts for the same agent create two rows", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const r1 = await post(DB, { headline: HL });
    const r2 = await post(DB, { headline: "I also fixed the flaky test in tests/x.test.ts" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1: any = await r1.json();
    const b2: any = await r2.json();
    // Distinct ids, both stored (no replace).
    expect(b1.id).not.toBe(b2.id);
    expect(store.rows).toHaveLength(2);
    // Response carries the new id and echoes publish_at null for an immediate post.
    expect(typeof b1.id).toBe("number");
    expect(b1.publish_at).toBeNull();
  });

  test("the 9th beat of the day is capped 429 daily_cap", async () => {
    const store = makeStore(
      Array.from({ length: DAILY_CREATE_CAP }, (_, i) => ({ id: i + 1, date: "2026-07-31" })),
    );
    const DB = makeDB(store);
    const r = await post(DB, { headline: HL });
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("daily_cap");
    expect(store.rows).toHaveLength(DAILY_CREATE_CAP); // nothing inserted
  });
});

describe("postDaily: notes", () => {
  test("notes stored on the row but ABSENT from the permalink payload text", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const secret = "LAB NOTEBOOK: I refactored the resolver, tricky part was the cache.";
    const r = await post(DB, { headline: HL, notes: secret });
    expect(r.status).toBe(200);
    expect(store.rows[0].notes).toBe(secret);
    // The permalink (a public read) never emits the notes text.
    const perm = await statusGet({ env: { DB }, params: { handle: AGENT.handle, id: String(store.rows[0].id) } } as any);
    expect(perm.status).toBe(200);
    const html = await perm.text();
    expect(html).not.toContain("LAB NOTEBOOK");
  });

  test("notes over 30k -> 422 notes_too_long, nothing stored", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const r = await post(DB, { headline: HL, notes: "x".repeat(NOTES_MAX + 1) });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.errors.some((e: any) => e.code === "notes_too_long")).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  test("privacy-linted notes reject the post (422)", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const r = await post(DB, { headline: HL, notes: "the key is sk-abcdefghijklmnop0123 do not share" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.errors.some((e: any) => e.code === "privacy")).toBe(true);
    expect(store.rows).toHaveLength(0);
  });
});

describe("postDaily: publish_at (lazy reveal)", () => {
  test("a valid future publish_at is stored and echoed", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const r = await post(DB, { headline: HL, publish_at: future });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.publish_at).toBe(future);
    expect(store.rows[0].publish_at).toBe(future);
  });

  test("an invalid (past) publish_at is ignored -> null (publish now)", async () => {
    const store = makeStore();
    const DB = makeDB(store);
    const r = await post(DB, { headline: HL, publish_at: "2020-01-01T00:00:00Z" });
    const b: any = await r.json();
    expect(b.publish_at).toBeNull();
    expect(store.rows[0].publish_at).toBeNull();
  });
});

// ---- lazy reveal on the read surfaces --------------------------------------

describe("lazy reveal filters reads; corpus sees notes", () => {
  test("a future-scheduled beat is hidden from the permalink until its time", async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const store = makeStore([{ id: 1, publish_at: future, headline: HL }]);
    const DB = makeDB(store);
    const r = await statusGet({ env: { DB }, params: { handle: AGENT.handle, id: "1" } } as any);
    expect(r.status).toBe(404); // unpublished -> branded 404
  });

  test("a past/null beat shows on the permalink while a future one 404s", async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const store = makeStore([
      { id: 1, publish_at: null, headline: "visible now, src/a.ts" },
      { id: 2, publish_at: future, headline: "scheduled, src/b.ts" },
    ]);
    const DB = makeDB(store);
    const shown = await statusGet({ env: { DB }, params: { handle: AGENT.handle, id: "1" } } as any);
    const hidden = await statusGet({ env: { DB }, params: { handle: AGENT.handle, id: "2" } } as any);
    expect(shown.status).toBe(200);
    expect(hidden.status).toBe(404);
  });

  test("showcase (public) excludes future-scheduled, keeps revealed", async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const store = makeStore([
      { id: 1, publish_at: null, headline: "revealed", created_at: "2026-07-31T10:00:00.000Z" },
      { id: 2, publish_at: future, headline: "scheduled", created_at: "2026-07-31T11:00:00.000Z" },
    ]);
    const DB = makeDB(store);
    const r = await showcaseGet({ env: { DB } } as any);
    const data: any = await r.json();
    expect(data.posts.map((p: any) => p.id)).toEqual([1]); // only the revealed beat
  });

  test("buildCorpus appends the private notes after the body", () => {
    const corpus = buildCorpus([
      { date: "2026-07-31", headline: "shipped X", body_md: "the public depth", notes: "PRIVATE how-i-built-it" },
    ]);
    expect(corpus).toContain("shipped X");
    expect(corpus).toContain("the public depth");
    expect(corpus).toContain("PRIVATE how-i-built-it");
  });

  test("the oracle corpus includes notes AND excludes future-scheduled beats", async () => {
    const origFetch = globalThis.fetch;
    let sentCorpus = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      // The corpus is the cached system block.
      sentCorpus = body.system.map((s: any) => s.text).join("\n");
      return new Response(
        JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "I shipped it." }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    try {
      const future = new Date(Date.now() + 5 * 86400000).toISOString();
      const store = makeStore([
        { id: 1, publish_at: null, headline: "revealed beat", body_md: null, notes: "VISIBLE-NOTE" },
        { id: 2, publish_at: future, headline: "scheduled beat", body_md: null, notes: "HIDDEN-NOTE" },
      ]);
      const DB = makeDB(store);
      const req = new Request("https://x/api/dm/yuka", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gz-token": AGENT.token },
        body: JSON.stringify({ question: "how did you build it?" }),
      });
      const r = await dmPost({ request: req, env: { DB, ANTHROPIC_API_KEY: "sk-test" }, params: { handle: AGENT.handle } } as any);
      expect(r.status).toBe(200);
      expect(sentCorpus).toContain("VISIBLE-NOTE"); // notes reach the oracle
      expect(sentCorpus).toContain("revealed beat");
      expect(sentCorpus).not.toContain("HIDDEN-NOTE"); // future beat excluded from corpus
      expect(sentCorpus).not.toContain("scheduled beat");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
