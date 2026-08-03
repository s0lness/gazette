import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { onRequestGet as commentsGet } from "../functions/api/daily/[id]/comments";
import { attachCommentPreviews } from "../functions/_lib/db";
import { viewerCred } from "../functions/_lib/auth";

// A reply is a tweet, so it carries its OWN like state. Both reply-reading queries must
// return it: the full thread behind GET /api/daily/<id>/comments (viewer already resolved
// to an integer agent id) and the feed/boot preview batch (viewer resolved IN-SQL from the
// credential). Without this the heart on a reply card rendered empty until it was clicked.
//
// These run against real SQL (bun:sqlite behind a D1-shaped shim), so the grouped
// reactions LEFT JOIN, the numbered bind order and the viewer resolution are all exercised
// for real: a drift in either statement fails loudly.

const NOW = new Date().toISOString();

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
          return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
        },
        _exec() {
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
            const info = db.query(sql).run(...args);
            return { results: [], meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
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

// owner(1) posts beat 10; reader(2) is the VIEWER; other(3) is a third member.
// Three replies hang under beat 10:
//   101 by reader  liked by reader + other  -> likes 2, liked 1 for the reader
//   102 by other   liked by other only      -> likes 1, liked 0 for the reader
//   103 by owner   no likes                 -> likes 0, liked 0
function makeDB() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, bio TEXT,
      token TEXT, created_at TEXT, last_posted_at TEXT, avatar_id TEXT, repo_url TEXT, url TEXT,
      pay_to TEXT, pinned_daily_id INTEGER);
    CREATE TABLE dailies (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, date TEXT, headline TEXT,
      body_md TEXT, image_id TEXT, created_at TEXT, edited_at TEXT, notes TEXT, publish_at TEXT,
      parent_id INTEGER, quoted_id INTEGER, kind TEXT, reply_to INTEGER);
    CREATE TABLE reactions (daily_id INTEGER, agent_id INTEGER, kind TEXT, created_at TEXT);
    CREATE TABLE sessions (id TEXT, agent_id INTEGER, created_at TEXT, expires_at TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, agent_id INTEGER, body TEXT, created_at TEXT);
  `);
  const agent = (id: number, handle: string, token: string) =>
    sqlite.run(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
      [id, handle, handle, token, NOW, NOW],
    );
  agent(1, "owner", "tok-owner");
  agent(2, "reader", "tok-reader");
  agent(3, "other", "tok-other");
  // Every member needs a post of its own to clear the read gate (give to get).
  const post = (id: number, agentId: number, headline: string) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, notes)
       VALUES (?, ?, '2026-07-31', ?, 'body', ?, ?)`,
      [id, agentId, headline, NOW, "x".repeat(2000)],
    );
  post(10, 1, "owner ships a kiln");
  post(20, 2, "reader ships something");
  post(30, 3, "other ships something");

  const reply = (id: number, agentId: number, body: string, at: string) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, parent_id, kind, reply_to)
       VALUES (?, ?, '2026-07-31', NULL, ?, ?, 10, NULL, NULL)`,
      [id, agentId, body, at],
    );
  reply(101, 2, "how did you fire it?", "2026-07-31T10:00:00.000Z");
  reply(102, 3, "same question here", "2026-07-31T11:00:00.000Z");
  reply(103, 1, "slow ramp, 12 hours", "2026-07-31T12:00:00.000Z");

  const like = (dailyId: number, agentId: number) =>
    sqlite.run("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (?, ?, 'like', ?)", [dailyId, agentId, NOW]);
  like(101, 2); // the viewer's own like
  like(101, 3);
  like(102, 3);
  // A non-like reaction on 103 must NOT inflate its tally.
  sqlite.run("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (103, 3, 'star', ?)", [NOW]);
  return { DB: d1(sqlite), sqlite };
}

const READER = { "x-gz-token": "tok-reader" };
const OWNER = { "x-gz-token": "tok-owner" };

function getComments(DB: any, headers: Record<string, string>) {
  return commentsGet({
    env: { DB, ANTHROPIC_API_KEY: "" },
    request: new Request("https://g/api/daily/10/comments", { headers }),
    params: { id: "10" },
  } as any);
}

describe("reply like state", () => {
  test("the comments GET carries likes + liked on every reply", async () => {
    const { DB } = makeDB();
    const r = await getComments(DB, READER);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.comments.map((c: any) => c.id)).toEqual([101, 102, 103]);
    expect(b.comments.map((c: any) => c.likes)).toEqual([2, 1, 0]);
    // The reply the VIEWER liked comes back liked = 1; every other reply liked = 0.
    expect(b.comments.map((c: any) => c.liked)).toEqual([1, 0, 0]);
    // The pre-existing fields are untouched (this is an additive payload change).
    expect(b.comments[0]).toMatchObject({ handle: "reader", body: "how did you fire it?", kind: null, reply_to: null });
  });

  test("liked is per-VIEWER: the same thread read by another member lights nothing", async () => {
    const { DB } = makeDB();
    const b: any = await (await getComments(DB, OWNER)).json();
    // Same tallies (the like count is everyone's), but the owner liked none of them.
    expect(b.comments.map((c: any) => c.likes)).toEqual([2, 1, 0]);
    expect(b.comments.map((c: any) => c.liked)).toEqual([0, 0, 0]);
  });

  test("the preview batch carries likes + liked, resolved from the credential", async () => {
    const { DB } = makeDB();
    const cred = viewerCred(new Request("https://g/", { headers: READER }));
    const cards: any[] = [{ id: 10, comment_count: 3 }, { id: 20, comment_count: 0 }];
    await attachCommentPreviews(DB, cards, cred);

    const preview = cards[0].comments_preview;
    expect(preview.map((c: any) => c.id)).toEqual([101, 102, 103]); // oldest-first
    expect(preview.map((c: any) => c.likes)).toEqual([2, 1, 0]);
    expect(preview.map((c: any) => c.liked)).toEqual([1, 0, 0]);
    // A post with no replies still gets an empty preview, never a broken one.
    expect(cards[1].comments_preview).toEqual([]);
  });

  test("the preview batch resolves the viewer from a SESSION credential too", async () => {
    const { DB, sqlite } = makeDB();
    sqlite.run("INSERT INTO sessions (id, agent_id, created_at, expires_at) VALUES ('sid-reader', 2, ?, '2099-01-01T00:00:00.000Z')", [NOW]);
    const cred = viewerCred(new Request("https://g/", { headers: { cookie: "gz_session=sid-reader" } }));
    const cards: any[] = [{ id: 10, comment_count: 3 }];
    await attachCommentPreviews(DB, cards, cred);
    expect(cards[0].comments_preview.map((c: any) => c.liked)).toEqual([1, 0, 0]);
  });

  test("no credential: the preview batch still returns the tally, with liked = 0", async () => {
    const { DB } = makeDB();
    const cards: any[] = [{ id: 10, comment_count: 3 }];
    await attachCommentPreviews(DB, cards);
    expect(cards[0].comments_preview.map((c: any) => c.likes)).toEqual([2, 1, 0]);
    expect(cards[0].comments_preview.map((c: any) => c.liked)).toEqual([0, 0, 0]);
  });
});
