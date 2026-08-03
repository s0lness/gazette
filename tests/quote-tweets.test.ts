import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { onRequestPost as commentPost } from "../functions/api/comment";
import { onRequestGet as commentsGet } from "../functions/api/daily/[id]/comments";
import { onRequestDelete as dailyDelete } from "../functions/api/daily/[id]/index";
import { postDaily } from "../functions/_lib/daily";
import { feedStmt, cardFromFoldedRow } from "../functions/_lib/db";
import { viewerCred } from "../functions/_lib/auth";

// Quote tweets: any tweet (a post OR a reply) may carry `quoted_id`, and every card path
// embeds the quoted tweet so the client renders the inner card with no second fetch.
// These run against real SQL (bun:sqlite behind a D1-shaped shim), so a broken join, a
// bind-order slip, or a dangling pointer fails loudly here rather than in production.

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
    CREATE TABLE images (id TEXT PRIMARY KEY, agent_id INTEGER);
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
      [id, handle, handle.toUpperCase(), token, NOW, NOW],
    );
  agent(1, "owner", "tok-owner");
  agent(2, "reader", "tok-reader");
  const post = (id: number, agentId: number, headline: string, publishAt: string | null = null) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, publish_at)
       VALUES (?, ?, '2026-07-31', ?, 'body with src/kiln.ts', ?, ?)`,
      [id, agentId, headline, NOW, publishAt],
    );
  post(10, 1, "owner ships a kiln, src/kiln.ts");
  post(20, 2, "reader ships something, src/read.ts");
  // A scheduled (not yet revealed) beat: quoting it must be refused.
  post(30, 1, "not revealed yet, src/later.ts", "2099-01-01T00:00:00.000Z");
  return { DB: d1(sqlite), sqlite };
}

const AGENT2 = { id: 2, handle: "reader", display_name: "READER", token: "tok-reader" } as any;
const READER = { "x-gz-token": "tok-reader" };
const OWNER = { "x-gz-token": "tok-owner" };

function reqPost(body: any, headers: Record<string, string>) {
  return new Request("https://g/api/comment", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Read the feed as `reader` and return the card for one id (the shape the client sees).
async function cardFor(DB: any, id: number) {
  const cred = viewerCred(new Request("https://g/", { headers: READER }));
  const rows = (await feedStmt(DB, cred, false).all<any>()).results;
  const row = rows.find((r: any) => r.id === id);
  return row ? cardFromFoldedRow(row) : null;
}

describe("quote tweets", () => {
  test("posting a beat with quoted_id stores it and echoes it back", async () => {
    const { DB, sqlite } = makeDB();
    const res = await postDaily(DB, AGENT2, {
      headline: "built on the kiln, src/glaze.ts",
      quoted_id: 10,
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.quoted_id).toBe(10);
    const row: any = sqlite.query("SELECT * FROM dailies WHERE id = ?").get(body.id);
    expect(row.quoted_id).toBe(10);
  });

  test("an unknown quoted_id is refused 422 bad_quote and nothing is written", async () => {
    const { DB, sqlite } = makeDB();
    const before = (sqlite.query("SELECT COUNT(*) AS n FROM dailies").get() as any).n;
    const res = await postDaily(DB, AGENT2, { headline: "quoting a ghost, src/ghost.ts", quoted_id: 9999 });
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("bad_quote");
    expect((sqlite.query("SELECT COUNT(*) AS n FROM dailies").get() as any).n).toBe(before);
  });

  test("a not-yet-revealed tweet cannot be quoted (422 bad_quote)", async () => {
    const { DB } = makeDB();
    const res = await postDaily(DB, AGENT2, { headline: "quoting the future, src/soon.ts", quoted_id: 30 });
    expect(res.status).toBe(422);
    expect((await res.json() as any).code).toBe("bad_quote");
  });

  test("a card with quoted_id carries the embedded quoted tweet", async () => {
    const { DB } = makeDB();
    const res = await postDaily(DB, AGENT2, { headline: "built on the kiln, src/glaze.ts", quoted_id: 10 });
    const id = (await res.json() as any).id;

    const card: any = await cardFor(DB, id);
    expect(card).toBeTruthy();
    expect(card.quoted_id).toBe(10);
    expect(card.quoted).toMatchObject({
      id: 10,
      handle: "owner",
      display_name: "OWNER",
      headline: "owner ships a kiln, src/kiln.ts",
    });
    // A card that quotes nothing keeps a null quote, never a half-filled object.
    const plain: any = await cardFor(DB, 20);
    expect(plain.quoted_id).toBe(null);
    expect(plain.quoted).toBe(null);
  });

  test("deleting the quoted tweet leaves the quoting tweet with quoted: null", async () => {
    const { DB, sqlite } = makeDB();
    const res = await postDaily(DB, AGENT2, { headline: "built on the kiln, src/glaze.ts", quoted_id: 10 });
    const id = (await res.json() as any).id;

    const del = await dailyDelete({
      env: { DB },
      request: new Request("https://g/api/daily/10", { method: "DELETE", headers: OWNER }),
      params: { id: "10" },
    } as any);
    expect(del.status).toBe(200);

    // The quoting tweet survives (no cascade) and still reads cleanly.
    const card: any = await cardFor(DB, id);
    expect(card).toBeTruthy();
    expect(card.quoted_id).toBe(10);
    expect(card.quoted).toBe(null);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM dailies WHERE id = ?").get(id) as any).n).toBe(1);
  });

  test("a reply can carry quoted_id, and the thread read embeds the quote", async () => {
    const { DB, sqlite } = makeDB();
    const r = await commentPost({
      env: { DB },
      request: reqPost({ daily_id: 20, body: "this is why it works", quoted_id: 10 }, READER),
    } as any);
    expect(r.status).toBe(200);
    const created: any = await r.json();
    expect(created.comment.quoted_id).toBe(10);
    const reply: any = sqlite.query("SELECT * FROM dailies WHERE parent_id = 20").get();
    expect(reply.quoted_id).toBe(10);

    const g = await commentsGet({
      env: { DB, ANTHROPIC_API_KEY: "" },
      request: new Request("https://g/api/daily/20/comments", { headers: READER }),
      params: { id: "20" },
    } as any);
    expect(g.status).toBe(200);
    const body: any = await g.json();
    expect(body.comments.length).toBe(1);
    expect(body.comments[0].quoted_id).toBe(10);
    expect(body.comments[0].quoted).toMatchObject({ id: 10, handle: "owner" });
  });

  test("a reply quoting an unknown tweet is refused 422 bad_quote", async () => {
    const { DB, sqlite } = makeDB();
    const r = await commentPost({
      env: { DB },
      request: reqPost({ daily_id: 20, body: "quoting a ghost", quoted_id: 9999 }, READER),
    } as any);
    expect(r.status).toBe(422);
    expect((await r.json() as any).code).toBe("bad_quote");
    expect((sqlite.query("SELECT COUNT(*) AS n FROM dailies WHERE parent_id IS NOT NULL").get() as any).n).toBe(0);
  });

  test("the quoted author is notified (kind 'quote'), never for a self-quote", async () => {
    const { DB, sqlite } = makeDB();
    // reader quotes owner's post 10.
    await commentPost({
      env: { DB },
      request: reqPost({ daily_id: 20, body: "building on this", quoted_id: 10 }, READER),
    } as any);
    await Bun.sleep(10);
    const n: any = sqlite.query("SELECT * FROM notifications WHERE kind = 'quote'").get();
    expect(n).toBeTruthy();
    expect(n.agent_id).toBe(1); // the quoted author
    expect(n.actor_id).toBe(2); // the quoter

    // reader quotes its OWN post 20: no notification is written.
    const before = (sqlite.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'quote'").get() as any).n;
    await postDaily(DB, AGENT2, { headline: "self quote, src/self.ts", quoted_id: 20 }, { env: { DB } as any });
    await Bun.sleep(10);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'quote'").get() as any).n).toBe(before);
  });
});
