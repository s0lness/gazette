import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  NOTIF_BODY_MAX,
  truncBody,
  writeNotification,
  notifyDailyOwner,
  notifyCommentAuthor,
} from "../functions/_lib/notify";
import {
  onRequestGet as notifGet,
  onRequestPost as notifPost,
} from "../functions/api/me/notifications";
import { onRequestPost as commentPost } from "../functions/api/comment";
import { onRequestPost as followPost } from "../functions/api/follow";
import { onRequestPost as reactPost } from "../functions/api/react";
import { onRequestPost as savePost } from "../functions/api/save";
import { maybeOracleReply } from "../functions/_lib/oracle-reply";

// The human notification inbox, exercised against real SQL (bun:sqlite behind a D1-shaped
// shim): the writer (every kind, the self-skip, like coalescing), the handlers that
// trigger a write, and the GET/POST endpoints with their gate ladder.

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

// OWNER (id 1, token tok-owner) posts beat 10. ACTOR (id 2, token tok-actor) is the one
// doing things to it. Both are healthy members (recent beat + stored notes).
function makeDB() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, bio TEXT,
      token TEXT, created_at TEXT, last_posted_at TEXT, avatar_id TEXT, repo_url TEXT, url TEXT,
      pay_to TEXT, pinned_daily_id INTEGER);
    CREATE TABLE dailies (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, date TEXT, headline TEXT,
      body_md TEXT, image_id TEXT, created_at TEXT, edited_at TEXT, notes TEXT, publish_at TEXT,
      parent_id INTEGER, quoted_id INTEGER, kind TEXT, reply_to INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, daily_id INTEGER, agent_id INTEGER,
      body TEXT, created_at TEXT, kind TEXT, reply_to INTEGER, edited_at TEXT);
    CREATE TABLE reactions (daily_id INTEGER, agent_id INTEGER, kind TEXT, created_at TEXT);
    CREATE TABLE follows (follower_id INTEGER, followed_id INTEGER, created_at TEXT);
    CREATE TABLE saved_items (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER,
      daily_id INTEGER, created_at TEXT, UNIQUE(agent_id, daily_id));
    CREATE TABLE sessions (id TEXT, agent_id INTEGER, created_at TEXT, expires_at TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, agent_id INTEGER, body TEXT, created_at TEXT);
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
  agent(2, "actor", "tok-actor");
  const beat = (id: number, agentId: number, headline: string) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, notes)
       VALUES (?, ?, '2026-07-31', ?, 'body', ?, ?)`,
      [id, agentId, headline, NOW, "x".repeat(2000)],
    );
  beat(10, 1, "owner ships a kiln");
  beat(20, 2, "actor ships something");
  return { DB: d1(sqlite), sqlite };
}

function rows(sqlite: Database): any[] {
  return sqlite.query("SELECT * FROM notifications ORDER BY id").all() as any[];
}

function req(url: string, method = "GET", body?: any, headers: Record<string, string> = {}) {
  const init: any = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return new Request(url, init);
}
const OWNER = { "x-gz-token": "tok-owner" };
const ACTOR = { "x-gz-token": "tok-actor" };

// Collect the fire-and-forget work so a test can await it deterministically.
function collector() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    settle: () => Promise.all(pending),
  };
}

// ---- the writer -----------------------------------------------------------
describe("writeNotification", () => {
  test("writes each kind", async () => {
    const { DB, sqlite } = makeDB();
    const env: any = { DB };
    for (const kind of ["comment", "reply", "follow", "like", "saved", "ask"] as const) {
      expect(await writeNotification(env, { agent_id: 1, kind, actor_id: 2, daily_id: 10 })).toBe(true);
    }
    expect(rows(sqlite).map((r) => r.kind)).toEqual(["comment", "reply", "follow", "like", "saved", "ask"]);
  });

  test("never notifies you about your own action", async () => {
    const { DB, sqlite } = makeDB();
    const ok = await writeNotification({ DB } as any, { agent_id: 1, kind: "like", actor_id: 1, daily_id: 10 });
    expect(ok).toBe(false);
    expect(rows(sqlite)).toHaveLength(0);
  });

  test("refuses an unknown kind", async () => {
    const { DB, sqlite } = makeDB();
    const ok = await writeNotification({ DB } as any, { agent_id: 1, kind: "shrug" as any, actor_id: 2 });
    expect(ok).toBe(false);
    expect(rows(sqlite)).toHaveLength(0);
  });

  test("likes on the same beat coalesce while unread (created_at refreshed, no second row)", async () => {
    const { DB, sqlite } = makeDB();
    const env: any = { DB };
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 2, daily_id: 10 });
    const first = rows(sqlite)[0];
    // Force a distinguishable clock tick.
    sqlite.run("UPDATE notifications SET created_at = '2020-01-01T00:00:00.000Z'");
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 3, daily_id: 10 });
    const after = rows(sqlite);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0].created_at).not.toBe("2020-01-01T00:00:00.000Z"); // floated back to the top
  });

  test("a like on a DIFFERENT beat is its own row", async () => {
    const { DB, sqlite } = makeDB();
    const env: any = { DB };
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 2, daily_id: 10 });
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 2, daily_id: 11 });
    expect(rows(sqlite)).toHaveLength(2);
  });

  test("a like coalesces only while UNREAD: a read row does not absorb the next one", async () => {
    const { DB, sqlite } = makeDB();
    const env: any = { DB };
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 2, daily_id: 10 });
    sqlite.run("UPDATE notifications SET read_at = ?", [NOW]);
    await writeNotification(env, { agent_id: 1, kind: "like", actor_id: 2, daily_id: 10 });
    expect(rows(sqlite)).toHaveLength(2);
  });

  test("a broken table never throws into the caller", async () => {
    const sqlite = new Database(":memory:"); // no notifications table at all
    const ok = await writeNotification({ DB: d1(sqlite) } as any, { agent_id: 1, kind: "follow", actor_id: 2 });
    expect(ok).toBe(false);
  });

  test("notifyDailyOwner resolves the beat's owner; notifyCommentAuthor the comment's", async () => {
    const { DB, sqlite } = makeDB();
    const env: any = { DB };
    await notifyDailyOwner(env, 10, { kind: "saved", actor_id: 2 });
    // A comment is now a reply tweet in dailies (parent_id = the post, body_md = text).
    sqlite.run(
      "INSERT INTO dailies (id, parent_id, agent_id, body_md, date, created_at) VALUES (77, 10, 2, 'q', '2026-07-31', ?)",
      [NOW],
    );
    await notifyCommentAuthor(env, 77, { kind: "reply", actor_id: 1, daily_id: 10, comment_id: 88 });
    const all = rows(sqlite);
    expect(all[0]).toMatchObject({ agent_id: 1, kind: "saved", daily_id: 10 });
    expect(all[1]).toMatchObject({ agent_id: 2, kind: "reply", comment_id: 88 });
  });

  test("an unknown beat or comment writes nothing", async () => {
    const { DB, sqlite } = makeDB();
    expect(await notifyDailyOwner({ DB } as any, 999, { kind: "like", actor_id: 2 })).toBe(false);
    expect(await notifyCommentAuthor({ DB } as any, 999, { kind: "reply", actor_id: 2 })).toBe(false);
    expect(rows(sqlite)).toHaveLength(0);
  });

  test("truncBody clips at 140 chars and drops blank bodies", () => {
    expect(truncBody("  hi  ")).toBe("hi");
    expect(truncBody("   ")).toBe(null);
    expect(truncBody(null)).toBe(null);
    const long = truncBody("z".repeat(400))!;
    expect(long.length).toBe(NOTIF_BODY_MAX);
    expect(long.endsWith("...")).toBe(true);
  });
});

// ---- the triggering handlers ----------------------------------------------
describe("handlers write notifications", () => {
  test("comment on someone's beat notifies its owner with the truncated body", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    const r = await commentPost({
      env: { DB },
      request: req("https://g/api/comment", "POST", { daily_id: 10, body: "I hit this too, fixed it by batching the writes." }, ACTOR),
      waitUntil: c.waitUntil,
    } as any);
    expect(r.status).toBe(200);
    await c.settle();
    const all = rows(sqlite);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ agent_id: 1, kind: "comment", actor_id: 2, daily_id: 10 });
    expect(all[0].body).toBe("I hit this too, fixed it by batching the writes.");
  });

  test("commenting on your OWN beat notifies nobody", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await commentPost({
      env: { DB },
      request: req("https://g/api/comment", "POST", { daily_id: 10, body: "note to self: retry the batch." }, OWNER),
      waitUntil: c.waitUntil,
    } as any);
    await c.settle();
    expect(rows(sqlite)).toHaveLength(0);
  });

  test("a comment with reply_to also notifies the answered comment's author", async () => {
    const { DB, sqlite } = makeDB();
    // The answered comment is a reply tweet in dailies (parent_id = post 20).
    sqlite.run("INSERT INTO dailies (id, parent_id, agent_id, body_md, date, created_at) VALUES (55, 20, 1, 'how?', '2026-07-31', ?)", [NOW]);
    const c = collector();
    await commentPost({
      env: { DB },
      request: req("https://g/api/comment", "POST", { daily_id: 20, body: "By batching the writes, it dropped to 40ms.", reply_to: 55 }, ACTOR),
      waitUntil: c.waitUntil,
    } as any);
    await c.settle();
    const kinds = rows(sqlite).map((r) => r.kind);
    expect(kinds).toContain("reply");
    const reply = rows(sqlite).find((r) => r.kind === "reply");
    expect(reply).toMatchObject({ agent_id: 1, actor_id: 2, daily_id: 20 });
    // The reply context is persisted on the reply tweet row too (dailies).
    const row: any = sqlite.query("SELECT reply_to FROM dailies WHERE id = ?").get(reply!.comment_id);
    expect(row.reply_to).toBe(55);
  });

  test("following notifies the followed agent; unfollowing does not", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await followPost({
      env: { DB }, request: req("https://g/api/follow", "POST", { handle: "owner" }, ACTOR), waitUntil: c.waitUntil,
    } as any);
    await c.settle();
    expect(rows(sqlite)).toHaveLength(1);
    expect(rows(sqlite)[0]).toMatchObject({ agent_id: 1, kind: "follow", actor_id: 2 });

    const c2 = collector();
    await followPost({
      env: { DB }, request: req("https://g/api/follow", "POST", { handle: "owner" }, ACTOR), waitUntil: c2.waitUntil,
    } as any);
    await c2.settle();
    expect(rows(sqlite)).toHaveLength(1); // the unfollow is not news
  });

  test("liking notifies the beat's owner; unliking does not", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await reactPost({
      env: { DB }, request: req("https://g/api/react", "POST", { daily_id: 10, kind: "like" }, ACTOR), waitUntil: c.waitUntil,
    } as any);
    await c.settle();
    expect(rows(sqlite).map((r) => r.kind)).toEqual(["like"]);

    const c2 = collector();
    await reactPost({
      env: { DB }, request: req("https://g/api/react", "POST", { daily_id: 10, kind: "like" }, ACTOR), waitUntil: c2.waitUntil,
    } as any);
    await c2.settle();
    expect(rows(sqlite)).toHaveLength(1); // toggled off: nothing new
  });

  test("saving a beat notifies its owner; unsaving does not", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await savePost({
      env: { DB }, request: req("https://g/api/save", "POST", { daily_id: 10, action: "save" }, ACTOR), waitUntil: c.waitUntil,
    } as any);
    await c.settle();
    expect(rows(sqlite)[0]).toMatchObject({ agent_id: 1, kind: "saved", actor_id: 2, daily_id: 10 });

    const c2 = collector();
    await savePost({
      env: { DB }, request: req("https://g/api/save", "POST", { daily_id: 10, action: "unsave" }, ACTOR), waitUntil: c2.waitUntil,
    } as any);
    await c2.settle();
    expect(rows(sqlite)).toHaveLength(1);
  });

  test("an oracle reply notifies the human whose comment it answered", async () => {
    // A minimal fake env in the shape oracle-reply reads, plus a recorder for the
    // notification insert (the oracle path already runs inside waitUntil).
    const inserted: { sql: string; binds: unknown[] }[] = [];
    const AUTHOR = { id: 1, handle: "owner", token: "tok-owner" };
    const daily = { id: 100, agent_id: AUTHOR.id, headline: "shipped a fix", body_md: "work in src/x.ts" };
    const comment = { id: 7, daily_id: 100, agent_id: 2, body: "how did you test it?", created_at: NOW, kind: null, reply_to: null, handle: "actor" };
    const DB: any = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt: any = {
          _sql: sql,
          bind(...a: unknown[]) { binds = a; return stmt; },
          async first() {
            // loadComment: a reply tweet joined to its author (dailies c ... parent_id IS NOT NULL).
            if (/FROM dailies c JOIN agents a/.test(sql)) return comment;
            // loadDaily: the parent post (dailies ... parent_id IS NULL).
            if (/FROM dailies WHERE id/.test(sql)) return daily;
            if (/FROM agents WHERE id/.test(sql)) return AUTHOR;
            return null;
          },
          async all() {
            if (/SELECT date, headline, body_md, notes FROM dailies/.test(sql)) {
              return { results: [{ date: "2026-07-30", headline: "shipped a fix", body_md: "w", notes: "tested it twice on real hardware" }] };
            }
            return { results: [] };
          },
          async run() {
            inserted.push({ sql, binds });
            return { meta: { last_row_id: 999, changes: 1 } };
          },
        };
        return stmt;
      },
      async batch(stmts: any[]) {
        return stmts.map((s: any) => ({ results: [{ n: 0 }] }));
      },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "I tested it twice on real hardware before shipping." }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as any;
    try {
      const ok = await maybeOracleReply({ DB, ANTHROPIC_API_KEY: "sk-test" } as any, 100, 7);
      expect(ok).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
    const notif = inserted.find((w) => /INSERT INTO notifications/.test(w.sql));
    expect(notif).toBeTruthy();
    // (agent_id, kind, actor_id, daily_id, comment_id, body, created_at)
    expect(notif!.binds[0]).toBe(2); // the commenter is notified
    expect(notif!.binds[1]).toBe("reply");
    expect(notif!.binds[2]).toBe(AUTHOR.id);
  });
});

// ---- GET / POST /api/me/notifications -------------------------------------
describe("GET /api/me/notifications", () => {
  function seed(sqlite: Database) {
    const ins = (id: number, kind: string, actor: number, daily: number | null, body: string | null, at: string, read: string | null) =>
      sqlite.run(
        "INSERT INTO notifications (id, agent_id, kind, actor_id, daily_id, comment_id, body, created_at, read_at) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?)",
        [id, kind, actor, daily, body, at, read],
      );
    ins(1, "follow", 2, null, null, "2026-07-29T10:00:00.000Z", NOW); // already read
    ins(2, "comment", 2, 10, "nice kiln", "2026-07-30T10:00:00.000Z", null);
    ins(3, "like", 2, 10, null, "2026-07-31T10:00:00.000Z", null);
  }

  test("returns the newest-first items, the unread tally, and the joined actor + beat", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    const r = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications", "GET", undefined, OWNER) } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.unread).toBe(2);
    expect(b.items.map((i: any) => i.id)).toEqual([3, 2, 1]);
    expect(b.items[1]).toMatchObject({
      kind: "comment",
      actor_handle: "actor",
      daily_id: 10,
      daily_headline: "owner ships a kiln",
      daily_handle: "owner",
      body: "nice kiln",
      read_at: null,
    });
    expect(b.items[2].read_at).toBe(NOW);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("?count=1 returns only the unread tally", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    const r = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications?count=1", "GET", undefined, OWNER) } as any);
    const b: any = await r.json();
    expect(b).toEqual({ ok: true, unread: 2 });
    expect(b.items).toBeUndefined();
  });

  test("another member sees their own (empty) inbox, never yours", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    const r = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications", "GET", undefined, ACTOR) } as any);
    const b: any = await r.json();
    expect(b.unread).toBe(0);
    expect(b.items).toEqual([]);
  });

  test("the gate ladder: 401 gated, 403 post_first, 403 context_starved", async () => {
    const { DB, sqlite } = makeDB();
    const anon = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications") } as any);
    expect(anon.status).toBe(401);
    expect((await anon.json() as any).code).toBe("gated");

    sqlite.run("INSERT INTO agents (id, handle, display_name, bio, token, created_at) VALUES (3, 'fresh', 'Fresh', '', 'tok-fresh', ?)", [NOW]);
    const fresh = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications", "GET", undefined, { "x-gz-token": "tok-fresh" }) } as any);
    expect(fresh.status).toBe(403);
    expect((await fresh.json() as any).code).toBe("post_first");

    const old = "2020-01-01T00:00:00.000Z";
    sqlite.run("INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at) VALUES (4, 'quiet', 'Quiet', '', 'tok-quiet', ?, ?)", [old, old]);
    sqlite.run("INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at) VALUES (30, 4, '2020-01-01', 'old', 'old', ?)", [old]);
    const quiet = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications", "GET", undefined, { "x-gz-token": "tok-quiet" }) } as any);
    expect(quiet.status).toBe(403);
    expect((await quiet.json() as any).code).toBe("context_starved");
  });

  test("?count=1 is gated too", async () => {
    const { DB } = makeDB();
    const r = await notifGet({ env: { DB }, request: req("https://g/api/me/notifications?count=1") } as any);
    expect(r.status).toBe(401);
  });
});

describe("POST /api/me/notifications", () => {
  function seed(sqlite: Database) {
    sqlite.run("INSERT INTO notifications (id, agent_id, kind, actor_id, daily_id, created_at) VALUES (1, 1, 'comment', 2, 10, ?)", [NOW]);
    sqlite.run("INSERT INTO notifications (id, agent_id, kind, actor_id, daily_id, created_at) VALUES (2, 1, 'like', 2, 10, ?)", [NOW]);
    sqlite.run("INSERT INTO notifications (id, agent_id, kind, actor_id, daily_id, created_at) VALUES (3, 2, 'like', 1, 20, ?)", [NOW]);
  }

  test("an empty body marks every unread notification read", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    const r = await notifPost({ env: { DB }, request: req("https://g/api/me/notifications", "POST", {}, OWNER) } as any);
    expect(r.status).toBe(200);
    expect((await r.json() as any)).toMatchObject({ ok: true, updated: 2 });
    const mine = rows(sqlite).filter((n) => n.agent_id === 1);
    expect(mine.every((n) => n.read_at)).toBe(true);
    // Someone else's row is untouched.
    expect(rows(sqlite).find((n) => n.agent_id === 2)!.read_at).toBe(null);
  });

  test("ids marks exactly those, and only the caller's", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    const r = await notifPost({ env: { DB }, request: req("https://g/api/me/notifications", "POST", { ids: [1, 3] }, OWNER) } as any);
    expect((await r.json() as any).updated).toBe(1); // row 3 belongs to agent 2
    const all = rows(sqlite);
    expect(all.find((n) => n.id === 1)!.read_at).not.toBe(null);
    expect(all.find((n) => n.id === 2)!.read_at).toBe(null);
    expect(all.find((n) => n.id === 3)!.read_at).toBe(null);
  });

  test("marking twice is idempotent (0 the second time)", async () => {
    const { DB, sqlite } = makeDB();
    seed(sqlite);
    await notifPost({ env: { DB }, request: req("https://g/api/me/notifications", "POST", {}, OWNER) } as any);
    const again = await notifPost({ env: { DB }, request: req("https://g/api/me/notifications", "POST", {}, OWNER) } as any);
    expect((await again.json() as any).updated).toBe(0);
  });

  test("a mark-read with no credential is gated", async () => {
    const { DB } = makeDB();
    const r = await notifPost({ env: { DB }, request: req("https://g/api/me/notifications", "POST", {}) } as any);
    expect(r.status).toBe(401);
  });
});
