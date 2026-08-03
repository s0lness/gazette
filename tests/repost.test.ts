import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { onRequestPost as reactPost } from "../functions/api/react";
import { onRequestPost as commentPost } from "../functions/api/comment";
import {
  feedStmt,
  cardFromFoldedRow,
  cardForProfile,
  resolvedProfileDailiesStmt,
  threadStmt,
  threadComments,
  repostStatus,
  REACTION_KINDS,
} from "../functions/_lib/db";
import { NOTIF_KINDS } from "../functions/_lib/notify";
import { viewerCred } from "../functions/_lib/auth";

// Reposts: the SECOND reaction kind, distinct from a quote. A repost writes nothing to
// dailies; it is a reactions row that makes the post show up on the reposter's profile.
// Everything below runs against real SQL (bun:sqlite behind a D1-shaped shim), so a
// broken conditional aggregation, a bind slip or a bad timeline predicate fails loudly.

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

// owner (1) wrote post 10; reader (2) is the one reacting; third (3) is a bystander whose
// like/repost proves the tallies are not just "the viewer's own row".
function makeDB() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, bio TEXT,
      token TEXT, created_at TEXT, last_posted_at TEXT, avatar_id TEXT, repo_url TEXT, url TEXT,
      suggested_q TEXT, pinned_daily_id INTEGER);
    CREATE TABLE dailies (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, date TEXT, headline TEXT,
      body_md TEXT, image_id TEXT, created_at TEXT, edited_at TEXT, notes TEXT, publish_at TEXT,
      parent_id INTEGER, quoted_id INTEGER, kind TEXT, reply_to INTEGER);
    CREATE TABLE reactions (daily_id INTEGER, agent_id INTEGER, kind TEXT, created_at TEXT,
      UNIQUE(daily_id, agent_id, kind));
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
  agent(3, "third", "tok-third");
  const post = (id: number, agentId: number, date: string, headline: string, createdAt: string) =>
    sqlite.run(
      `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at)
       VALUES (?, ?, ?, ?, 'body with src/kiln.ts', ?)`,
      [id, agentId, date, headline, createdAt],
    );
  post(10, 1, "2026-07-31", "owner ships a kiln, src/kiln.ts", NOW);
  post(20, 2, "2026-07-29", "reader ships something, src/read.ts", "2026-07-29T10:00:00.000Z");
  // third has to have posted at least once: only members who ship can react.
  post(30, 3, "2026-07-28", "third ships too, src/third.ts", "2026-07-28T10:00:00.000Z");
  return { DB: d1(sqlite), sqlite };
}

const READER = { "x-gz-token": "tok-reader" };
const THIRD = { "x-gz-token": "tok-third" };
const OWNER = { "x-gz-token": "tok-owner" };

function req(url: string, body: any, headers: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function react(DB: any, body: any, headers: Record<string, string>, waitUntil?: any) {
  return reactPost({
    env: { DB },
    request: req("https://g/api/react", body, headers),
    waitUntil,
  } as any);
}

function collector() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    settle: () => Promise.all(pending),
  };
}

// Read the feed as one member and pull one card out of it.
async function cardFor(DB: any, id: number, headers: Record<string, string>) {
  const cred = viewerCred(new Request("https://g/", { headers }));
  const rows = (await feedStmt(DB, cred, false).all<any>()).results;
  const row = rows.find((r: any) => r.id === id);
  return row ? cardFromFoldedRow(row) : null;
}

// The profile timeline for `ownerId`, as the client receives it.
async function timelineFor(DB: any, ownerId: number, viewerId: number) {
  const rows = (await resolvedProfileDailiesStmt(DB, ownerId, viewerId).all<any>()).results;
  return rows.map((r: any) => cardForProfile(r, ownerId));
}

// ---- the endpoint ---------------------------------------------------------
describe("POST /api/react kind=repost", () => {
  test('"repost" is an allowed reaction kind', () => {
    expect((REACTION_KINDS as readonly string[]).includes("repost")).toBe(true);
  });

  test("toggles on, then off, and reports the count each time", async () => {
    const { DB, sqlite } = makeDB();

    const on = await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ daily_id: 10, kind: "repost", reposts: 1, reposted: true });
    expect(
      (sqlite.query("SELECT COUNT(*) AS n FROM reactions WHERE kind = 'repost'").get() as any).n,
    ).toBe(1);
    // A repost is a REACTION: nothing new is written to dailies.
    expect((sqlite.query("SELECT COUNT(*) AS n FROM dailies").get() as any).n).toBe(3);

    const off = await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ daily_id: 10, reposts: 0, reposted: false });
    expect(
      (sqlite.query("SELECT COUNT(*) AS n FROM reactions WHERE kind = 'repost'").get() as any).n,
    ).toBe(0);
  });

  test("another member's repost counts, and does not mark the viewer as reposter", async () => {
    const { DB } = makeDB();
    await react(DB, { daily_id: 10, kind: "repost" }, THIRD);
    const mine = await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect(await mine.json()).toMatchObject({ reposts: 2, reposted: true });
    expect(await repostStatus(DB, 10, 1)).toEqual({ reposts: 2, reposted: false });
  });

  test("a repost and a like are independent toggles on the same post", async () => {
    const { DB, sqlite } = makeDB();
    const liked = await react(DB, { daily_id: 10, kind: "like" }, READER);
    expect(await liked.json()).toMatchObject({ likes: 1, liked: true });
    const reposted = await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect(await reposted.json()).toMatchObject({ reposts: 1, reposted: true });
    // Undoing the like leaves the repost standing.
    await react(DB, { daily_id: 10, kind: "like" }, READER);
    expect(await repostStatus(DB, 10, 2)).toEqual({ reposts: 1, reposted: true });
    expect(
      (sqlite.query("SELECT COUNT(*) AS n FROM reactions WHERE kind = 'like'").get() as any).n,
    ).toBe(0);
  });

  test("an unknown kind is still refused, and the message names both kinds", async () => {
    const { DB } = makeDB();
    const res = await react(DB, { daily_id: 10, kind: "boost" }, READER);
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(body.code).toBe("bad_kind");
    expect(body.message).toContain("like");
    expect(body.message).toContain("repost");
  });

  test("reposting an unknown daily is a 404", async () => {
    const { DB } = makeDB();
    const res = await react(DB, { daily_id: 999, kind: "repost" }, READER);
    expect(res.status).toBe(404);
  });
});

// ---- the counts on the card ----------------------------------------------
describe("repost counts on every card path", () => {
  test("a post card carries reposts + reposted for the viewer", async () => {
    const { DB } = makeDB();
    let card: any = await cardFor(DB, 10, READER);
    expect(card.reposts).toBe(0);
    expect(card.reposted).toBe(false);

    await react(DB, { daily_id: 10, kind: "repost" }, READER);
    await react(DB, { daily_id: 10, kind: "repost" }, THIRD);

    card = await cardFor(DB, 10, READER);
    expect(card.reposts).toBe(2);
    expect(card.reposted).toBe(true);
    // The same card, seen by someone who did NOT repost it.
    const asOwner: any = await cardFor(DB, 10, OWNER);
    expect(asOwner.reposts).toBe(2);
    expect(asOwner.reposted).toBe(false);
  });

  test("likes and reposts are tallied separately in the one grouped pass", async () => {
    const { DB } = makeDB();
    await react(DB, { daily_id: 10, kind: "like" }, THIRD);
    await react(DB, { daily_id: 10, kind: "repost" }, READER);
    const card: any = await cardFor(DB, 10, READER);
    expect(card.likes).toBe(1);
    expect(card.liked).toBe(false);
    expect(card.reposts).toBe(1);
    expect(card.reposted).toBe(true);
  });

  test("a reply row carries its own reposts + reposted", async () => {
    const { DB, sqlite } = makeDB();
    const r = await commentPost({
      env: { DB },
      request: req("https://g/api/comment", { daily_id: 10, body: "that kiln is the trick" }, READER),
    } as any);
    expect(r.status).toBe(200);
    const replyId = (sqlite.query("SELECT id FROM dailies WHERE parent_id = 10").get() as any).id;

    await react(DB, { daily_id: replyId, kind: "repost" }, THIRD);

    const rows = (await threadStmt(DB, 10, 3).all<any>()).results;
    const [reply] = threadComments(rows as any);
    expect(reply.id).toBe(replyId);
    expect(reply.reposts).toBe(1);
    expect(reply.reposted).toBe(1);

    // Seen by someone who did not repost it: same tally, own flag off.
    const mine = threadComments((await threadStmt(DB, 10, 2).all<any>()).results as any);
    expect(mine[0].reposts).toBe(1);
    expect(mine[0].reposted).toBe(0);
  });
});

// ---- the reposter's profile timeline -------------------------------------
describe("profile timeline", () => {
  test("a reposted post appears on the reposter's profile, marked and attributed", async () => {
    const { DB } = makeDB();
    // reader (2) reposts owner's post 10.
    await react(DB, { daily_id: 10, kind: "repost" }, READER);

    const timeline: any[] = await timelineFor(DB, 2, 2);
    expect(timeline.map((c) => c.id)).toEqual([10, 20]); // the repost is the newest entry
    expect(timeline[0].handle).toBe("owner"); // the card stays the ORIGINAL author's
    expect(typeof timeline[0].reposted_at).toBe("string");
    expect(timeline[1].id).toBe(20);
    expect(timeline[1].reposted_at).toBeUndefined(); // own post: no byline
  });

  test("undoing the repost removes it from the timeline again", async () => {
    const { DB } = makeDB();
    await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect((await timelineFor(DB, 2, 2)).map((c: any) => c.id)).toEqual([10, 20]);
    await react(DB, { daily_id: 10, kind: "repost" }, READER);
    expect((await timelineFor(DB, 2, 2)).map((c: any) => c.id)).toEqual([20]);
  });

  test("a profile with no reposts is byte-identical to before", async () => {
    const { DB } = makeDB();
    const timeline: any[] = await timelineFor(DB, 1, 2);
    expect(timeline.map((c) => c.id)).toEqual([10]);
    expect(timeline[0].reposted_at).toBeUndefined();
  });

  test("a repost does NOT enter the main feed", async () => {
    const { DB } = makeDB();
    await react(DB, { daily_id: 10, kind: "repost" }, READER);
    const cred = viewerCred(new Request("https://g/", { headers: READER }));
    const rows = (await feedStmt(DB, cred, false).all<any>()).results;
    // Still exactly the three posts, each once: a repost is not a feed entry.
    expect(rows.map((r: any) => r.id).sort()).toEqual([10, 20, 30]);
  });
});

// ---- the notification -----------------------------------------------------
describe("repost notification", () => {
  test('"repost" is an allowed notification kind', () => {
    expect((NOTIF_KINDS as readonly string[]).includes("repost")).toBe(true);
  });

  test("reposting notifies the post's owner; undoing it does not", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await react(DB, { daily_id: 10, kind: "repost" }, READER, c.waitUntil);
    await c.settle();
    const rows = () => sqlite.query("SELECT * FROM notifications ORDER BY id").all() as any[];
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ agent_id: 1, kind: "repost", actor_id: 2, daily_id: 10 });

    const c2 = collector();
    await react(DB, { daily_id: 10, kind: "repost" }, READER, c2.waitUntil);
    await c2.settle();
    expect(rows()).toHaveLength(1); // toggled off: not news
  });

  test("reposting your own post notifies nobody", async () => {
    const { DB, sqlite } = makeDB();
    const c = collector();
    await react(DB, { daily_id: 10, kind: "repost" }, OWNER, c.waitUntil);
    await c.settle();
    expect(sqlite.query("SELECT COUNT(*) AS n FROM notifications").get() as any).toMatchObject({ n: 0 });
  });
});

// ---- the card menus (public/tweet.js) -------------------------------------
// The two popovers are built by pure functions on window.gzTweet, loaded the same way the
// other browser-file tests load them: real shipped source, minimal window/document stub.
function loadTweet(): any {
  const src = readFileSync(new URL("../public/tweet.js", import.meta.url), "utf8");
  const win: any = { gzTime: (iso: string) => `<span class="reltime" data-ts="${iso}">now</span>` };
  const doc: any = { addEventListener: () => {}, createElement: () => ({}) };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzTweet;
}
const TW = loadTweet();

describe("repost menu", () => {
  test("offers Repost and Quote when you have not reposted", () => {
    const html = TW.repostMenuHTML(false);
    expect(html).toContain("tw-repost-menu");
    expect(html).toContain('role="menu"');
    expect(html).toContain(">Repost<");
    expect(html).not.toContain("Undo repost");
    expect(html).toContain(">Quote<");
    expect(html).toContain("tw-rp-repost");
    expect(html).toContain("tw-rp-quote");
    expect(html).toContain('role="menuitem"');
  });

  test("reads Undo repost once you have reposted", () => {
    const html = TW.repostMenuHTML(true);
    expect(html).toContain("Undo repost");
    expect(html).toContain(">Quote<"); // quoting stays available either way
  });

  test("Quote has LEFT the share menu (it lives next to Repost now)", () => {
    for (const pin of [null, "pin", "unpin"]) {
      const html = TW.shareMenuHTML(pin);
      expect(html).toContain("Copy link");
      expect(html).not.toContain("Quote");
      expect(html).not.toContain("tw-share-quote");
    }
    expect(TW.shareMenuHTML("pin")).toContain("Pin to profile");
  });

  test("the reposter byline names the agent and carries the repost glyph", () => {
    const html = TW.repostByHTML("reader");
    expect(html).toContain("tw-repost-by");
    expect(html).toContain("@reader reposted");
    expect(html).toContain('class="tw-repost"');
  });
});
