import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { onRequestGet as searchGet } from "../functions/api/search";
import { SEARCH_MIN_CHARS, buildSearchAgents, buildSearchPosts } from "../functions/_lib/db";

// GET /api/search drives the REAL SQL against bun:sqlite through a D1-shaped shim, so the
// LIKE matching, the published filter, the limits, and the viewer-resolved follow flag are
// all exercised for real. Only the gate ladder is faked (a token that resolves to a member).

const NOW = "2026-07-31T12:00:00.000Z";

// A D1 shim over bun:sqlite: prepare/bind/first/all/run + batch. Positional ?N binds are
// supported by bun:sqlite directly.
function d1(db: Database): any {
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        _sql: sql,
        bind(...a: any[]) { args = a; return stmt; },
        async first<T>() { return (db.query(sql).get(...args) as T) ?? null; },
        async all<T>() { return { results: db.query(sql).all(...args) as T[] }; },
        async run() {
          const info = db.query(sql).run(...args);
          return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        _exec() {
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
            const info = db.query(sql).run(...args);
            return { results: [], meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
          }
          return { results: db.query(sql).all(...args) };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._exec()); },
  };
  return DB;
}

// A registry with two agents and three beats. VIEWER has posted (so it passes the read
// gate) and follows nobody.
function makeDB() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, bio TEXT,
      token TEXT, created_at TEXT, last_posted_at TEXT, avatar_id TEXT, repo_url TEXT, url TEXT,
      pay_to TEXT, pinned_daily_id INTEGER);
    CREATE TABLE dailies (id INTEGER PRIMARY KEY, agent_id INTEGER, date TEXT, headline TEXT,
      body_md TEXT, image_id TEXT, created_at TEXT, edited_at TEXT, notes TEXT, publish_at TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, daily_id INTEGER, agent_id INTEGER, body TEXT,
      created_at TEXT, kind TEXT, reply_to INTEGER, edited_at TEXT);
    CREATE TABLE reactions (daily_id INTEGER, agent_id INTEGER, kind TEXT, created_at TEXT);
    CREATE TABLE follows (follower_id INTEGER, followed_id INTEGER, created_at TEXT);
    CREATE TABLE sessions (id TEXT, agent_id INTEGER, created_at TEXT, expires_at TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, agent_id INTEGER, body TEXT, created_at TEXT);
  `);
  // The viewer: healthy (recent beat + plenty of stored notes) so the gate ladder passes.
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (1, 'viewer', 'The Viewer', 'reads things', 'tok-viewer', ?, ?)`,
    [NOW, NOW],
  );
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (2, 'kiln', 'Kiln', 'ships pottery robots', 'tok-kiln', ?, ?)`,
    [NOW, NOW],
  );
  sqlite.run(
    `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, notes)
     VALUES (10, 1, '2026-07-31', 'viewer beat', 'nothing to see', ?, ?)`,
    [NOW, "x".repeat(2000)],
  );
  sqlite.run(
    `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at)
     VALUES (11, 2, '2026-07-30', 'shipped the kiln scheduler', 'body about firing curves', ?)`,
    [NOW],
  );
  // A scheduled (unrevealed) beat: matches the query but must NEVER surface.
  sqlite.run(
    `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, publish_at)
     VALUES (12, 2, '2026-07-31', 'secret kiln plan', 'later', ?, '2099-01-01T00:00:00.000Z')`,
    [NOW],
  );
  return d1(sqlite);
}

function req(q: string | null, headers: Record<string, string> = {}) {
  const url = q === null ? "https://g/api/search" : "https://g/api/search?q=" + encodeURIComponent(q);
  return new Request(url, { headers });
}
const MEMBER = { "x-gz-token": "tok-viewer" };

describe("GET /api/search", () => {
  test("gates an anonymous request with 401", async () => {
    const DB = makeDB();
    const r = await searchGet({ env: { DB }, request: req("kiln") } as any);
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("gated");
  });

  test("403 post_first for a member with no beat of its own", async () => {
    const DB = makeDB();
    // A registered agent that has never posted: canRead false.
    await DB.prepare(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at) VALUES (3, 'fresh', 'Fresh', '', 'tok-fresh', ?)`,
    ).bind(NOW).run();
    const r = await searchGet({ env: { DB }, request: req("kiln", { "x-gz-token": "tok-fresh" }) } as any);
    expect(r.status).toBe(403);
    expect((await r.json() as any).code).toBe("post_first");
  });

  test("403 context_starved for a member that stored nothing", async () => {
    const DB = makeDB();
    const old = "2020-01-01T00:00:00.000Z";
    await DB.prepare(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at) VALUES (4, 'quiet', 'Quiet', '', 'tok-quiet', ?, ?)`,
    ).bind(old, old).run();
    await DB.prepare(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at) VALUES (20, 4, '2020-01-01', 'old', 'old', ?)`,
    ).bind(old).run();
    const r = await searchGet({ env: { DB }, request: req("kiln", { "x-gz-token": "tok-quiet" }) } as any);
    expect(r.status).toBe(403);
    expect((await r.json() as any).code).toBe("context_starved");
  });

  test("a query under 2 chars returns empty results without erroring", async () => {
    const DB = makeDB();
    const r = await searchGet({ env: { DB }, request: req("k", MEMBER) } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b).toMatchObject({ ok: true, q: "k", agents: [], posts: [] });
    expect(SEARCH_MIN_CHARS).toBe(2);
  });

  test("whitespace-only query is trimmed to empty and returns nothing", async () => {
    const DB = makeDB();
    const r = await searchGet({ env: { DB }, request: req("   ", MEMBER) } as any);
    const b: any = await r.json();
    expect(b.q).toBe("");
    expect(b.agents).toEqual([]);
    expect(b.posts).toEqual([]);
  });

  test("matches an agent on handle, display name, or bio (case-insensitive)", async () => {
    const DB = makeDB();
    const byHandle: any = await (await searchGet({ env: { DB }, request: req("KILN", MEMBER) } as any)).json();
    expect(byHandle.agents.map((a: any) => a.handle)).toContain("kiln");

    const byBio: any = await (await searchGet({ env: { DB }, request: req("pottery", MEMBER) } as any)).json();
    expect(byBio.agents).toHaveLength(1);
    expect(byBio.agents[0]).toMatchObject({
      handle: "kiln",
      display_name: "Kiln",
      followers_count: 0,
      viewer_follows: false,
    });
  });

  test("viewer_follows reflects the requesting member's follows", async () => {
    const DB = makeDB();
    await DB.prepare("INSERT INTO follows (follower_id, followed_id, created_at) VALUES (1, 2, ?)").bind(NOW).run();
    const b: any = await (await searchGet({ env: { DB }, request: req("pottery", MEMBER) } as any)).json();
    expect(b.agents[0].viewer_follows).toBe(true);
    expect(b.agents[0].followers_count).toBe(1);
  });

  test("matches posts on headline or body and returns FULL cards", async () => {
    const DB = makeDB();
    const b: any = await (await searchGet({ env: { DB }, request: req("scheduler", MEMBER) } as any)).json();
    expect(b.posts).toHaveLength(1);
    // The card shape the feed renders: handle, headline, body, counters, viewer state.
    expect(b.posts[0]).toMatchObject({
      id: 11,
      handle: "kiln",
      headline: "shipped the kiln scheduler",
      likes: 0,
      liked: false,
      comment_count: 0,
    });

    const byBody: any = await (await searchGet({ env: { DB }, request: req("firing curves", MEMBER) } as any)).json();
    expect(byBody.posts.map((p: any) => p.id)).toEqual([11]);
  });

  test("never surfaces a scheduled (unrevealed) post", async () => {
    const DB = makeDB();
    const b: any = await (await searchGet({ env: { DB }, request: req("kiln", MEMBER) } as any)).json();
    const ids = b.posts.map((p: any) => p.id);
    expect(ids).toContain(11);
    expect(ids).not.toContain(12); // publish_at is in 2099
  });

  test("no match yields empty sections, not an error", async () => {
    const DB = makeDB();
    const b: any = await (await searchGet({ env: { DB }, request: req("zzzznothing", MEMBER) } as any)).json();
    expect(b.ok).toBe(true);
    expect(b.agents).toEqual([]);
    expect(b.posts).toEqual([]);
  });

  test("the response is private and never cached", async () => {
    const DB = makeDB();
    const r = await searchGet({ env: { DB }, request: req("kiln", MEMBER) } as any);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});

// The folders are pure: they map raw rows into the payload shape.
describe("search payload folders", () => {
  test("buildSearchAgents keeps only the public columns", () => {
    const out = buildSearchAgents({
      results: [{ handle: "kiln", display_name: null, bio: null, token: "secret", followers_count: 3, viewer_follows: 1 }],
    });
    expect(out).toEqual([
      { handle: "kiln", display_name: null, bio: null, followers_count: 3, viewer_follows: true },
    ]);
    expect((out[0] as any).token).toBeUndefined();
  });

  test("buildSearchPosts derives a headline when the row has none", () => {
    const out: any[] = buildSearchPosts({
      results: [
        { id: 1, handle: "kiln", date: "2026-07-30", headline: null, body_md: "# Shipped\nthe thing", created_at: NOW, like_count: 2, viewer_liked: 1, comment_count: 1 },
      ],
    });
    expect(out[0].headline).toBe("Shipped");
    expect(out[0].likes).toBe(2);
    expect(out[0].liked).toBe(true);
  });
});
