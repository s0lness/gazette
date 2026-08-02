import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { onRequestPost as commentPost } from "../functions/api/comment";
import { onRequestGet as commentsGet } from "../functions/api/daily/[id]/comments";
import { onRequestDelete as dailyDelete } from "../functions/api/daily/[id]/index";
import { feedStmt, dailiesCount } from "../functions/_lib/db";
import { viewerCred } from "../functions/_lib/auth";

// End-to-end guards for the unified model: posts and replies both live in `dailies`.
// A reply is a dailies row with parent_id = the target tweet id, body_md = the text.
// These run against real SQL (bun:sqlite behind a D1-shaped shim), so a schema/SQL
// drift (a post read that forgets `parent_id IS NULL`, a reply insert into the wrong
// table) fails loudly.

const NOW = "2026-07-31T12:00:00.000Z";

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
    CREATE TABLE follows (follower_id INTEGER, followed_id INTEGER, created_at TEXT);
    CREATE TABLE saved_items (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER,
      daily_id INTEGER, created_at TEXT, UNIQUE(agent_id, daily_id));
    CREATE TABLE sessions (id TEXT, agent_id INTEGER, created_at TEXT, expires_at TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, agent_id INTEGER, body TEXT, created_at TEXT);
    CREATE TABLE corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, comment_id INTEGER,
      note TEXT, created_at TEXT, resolved_at TEXT);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL,
      kind TEXT NOT NULL, actor_id INTEGER, daily_id INTEGER, comment_id INTEGER, body TEXT,
      created_at TEXT NOT NULL, read_at TEXT);
  `);
  const agent = (id: number, handle: string, token: string) =>
    sqlite.run(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
      [id, handle, handle, token, NOW, NOW],
    );
  agent(1, "owner", "tok-owner");
  agent(2, "reader", "tok-reader");
  // OWNER's post + enough context so both agents pass the read gate (owner has a post;
  // reader gets a post too so canRead is satisfied).
  const post = (id: number, agentId: number, headline: string) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, notes)
       VALUES (?, ?, '2026-07-31', ?, 'body', ?, ?)`,
      [id, agentId, headline, NOW, "x".repeat(2000)],
    );
  post(10, 1, "owner ships a kiln");
  post(20, 2, "reader ships something");
  return { DB: d1(sqlite), sqlite };
}

const READER = { "x-gz-token": "tok-reader" };
const OWNER = { "x-gz-token": "tok-owner" };

function reqPost(body: any, headers: Record<string, string>) {
  return new Request("https://g/api/comment", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("unified tweets model", () => {
  test("a reply write lands in dailies with parent_id = the target post", async () => {
    const { DB, sqlite } = makeDB();
    const r = await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "how did you fire it?" }, READER) } as any);
    expect(r.status).toBe(200);
    // The reply is a dailies row: parent_id = 10, body_md carries the text, headline NULL.
    const reply: any = sqlite.query("SELECT * FROM dailies WHERE parent_id IS NOT NULL").get();
    expect(reply.parent_id).toBe(10);
    expect(reply.body_md).toBe("how did you fire it?");
    expect(reply.headline).toBe(null);
    expect(reply.agent_id).toBe(2);
  });

  test("a POST read excludes replies (parent_id IS NULL): feed + dailiesCount", async () => {
    const { DB, sqlite } = makeDB();
    // Add a reply under post 10.
    await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "a reply, not a post" }, READER) } as any);

    // The feed (global branch) must return ONLY the two posts, never the reply row.
    const cred = viewerCred(new Request("https://g/", { headers: READER }));
    const feedRows = (await feedStmt(DB, cred, false).all<any>()).results;
    const ids = feedRows.map((x: any) => x.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([10, 20]);
    for (const row of feedRows) expect(row.headline).not.toBe(null); // replies (null headline) never leak

    // dailiesCount (the read-gate "gave to get") counts owner's POSTS only, not the reply.
    // Owner (id 1) authored post 10 only; the reader's reply under it must not count for owner.
    expect(await dailiesCount(DB, 1)).toBe(1);
  });

  test("reply-to-a-reply is accepted (target may be a reply, not just a post)", async () => {
    const { DB, sqlite } = makeDB();
    // First reply under post 10.
    await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "first reply" }, READER) } as any);
    const first: any = sqlite.query("SELECT id FROM dailies WHERE parent_id = 10").get();
    // Owner replies to that reply: target = the reply's id, which is any tweet.
    const r = await commentPost({
      env: { DB },
      request: reqPost({ daily_id: first.id, body: "answering your reply", reply_to: first.id }, OWNER),
    } as any);
    expect(r.status).toBe(200);
    const child: any = sqlite.query("SELECT * FROM dailies WHERE parent_id = ?").get(first.id);
    expect(child).toBeTruthy();
    expect(child.parent_id).toBe(first.id);
    expect(child.reply_to).toBe(first.id);
  });

  test("the comments GET sources reply rows from dailies", async () => {
    const { DB, sqlite } = makeDB();
    await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "sourced from dailies" }, READER) } as any);
    const r = await commentsGet({ env: { DB, ANTHROPIC_API_KEY: "" }, request: new Request("https://g/api/daily/10/comments", { headers: READER }), params: { id: "10" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.comments.length).toBe(1);
    expect(b.comments[0].body).toBe("sourced from dailies");
    expect(b.comments[0].kind).toBe(null);
  });

  test("deleting a POST cascades its reply rows (and their dependents)", async () => {
    const { DB, sqlite } = makeDB();
    // Two replies under post 10, plus a like on the post and one on a reply.
    await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "reply one" }, READER) } as any);
    await commentPost({ env: { DB }, request: reqPost({ daily_id: 10, body: "reply two" }, OWNER) } as any);
    const replyIds = (sqlite.query("SELECT id FROM dailies WHERE parent_id = 10").all() as any[]).map((x) => x.id);
    expect(replyIds.length).toBe(2);
    sqlite.run("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (10, 2, 'like', ?)", [NOW]);
    sqlite.run("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (?, 1, 'like', ?)", [replyIds[0], NOW]);

    const r = await dailyDelete({ env: { DB }, request: new Request("https://g/api/daily/10", { method: "DELETE", headers: OWNER }), params: { id: "10" } } as any);
    expect(r.status).toBe(200);
    expect((await r.json() as any).deleted).toBe(true);

    // The post AND its reply rows are gone.
    expect(sqlite.query("SELECT COUNT(*) AS n FROM dailies WHERE id = 10 OR parent_id = 10").get()).toMatchObject({ n: 0 });
    // Reactions on the post and on the replies are cleared.
    expect(sqlite.query("SELECT COUNT(*) AS n FROM reactions").get()).toMatchObject({ n: 0 });
    // The other post is untouched.
    expect(sqlite.query("SELECT COUNT(*) AS n FROM dailies WHERE id = 20").get()).toMatchObject({ n: 1 });
  });
});
