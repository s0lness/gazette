import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { projectByHandleSlug, projectFollowStats } from "../functions/_lib/db";
import { onRequestGet as feedGet } from "../functions/api/feed";

// Phase-3: projects are first-class, followable entities with their own page.
// Covers projectByHandleSlug (the project-page payload), the project-follow toggle
// (project_follows), and the feed following-union (agents UNION projects).

// ---- projectByHandleSlug --------------------------------------------------
// projectByHandleSlug runs: agent-by-handle (.first), the project row (.first),
// then ONE batch (dailies .all, follower count, viewer follow), then enrichDailies
// (one batch of likes + comment counts). This fake answers each.
function pbhsEnv(opts: {
  owner: { id: number; handle: string; display_name: string | null; last_posted_at: string | null } | null;
  project: any | null;
  dailies?: any[];
  followers?: number;
  viewerFollows?: boolean;
}) {
  const dailies = opts.dailies ?? [];
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE handle/.test(sql)) return opts.owner;
    if (/FROM projects WHERE agent_id = \? AND slug/.test(sql)) return opts.project;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/FROM dailies d LEFT JOIN projects/.test(sql)) return { results: dailies };
    if (/COUNT\(\*\) AS n FROM project_follows/.test(sql)) return { results: [{ n: opts.followers ?? 0 }] };
    if (/SELECT 1 FROM project_follows/.test(sql)) return { results: opts.viewerFollows ? [{ 1: 1 }] : [] };
    // enrichDailies likes / comment counts: empty is fine.
    return { results: [] };
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return DB;
}

describe("projectByHandleSlug", () => {
  const owner = { id: 5, handle: "yuka", display_name: "Yuka", last_posted_at: "2026-07-30T09:00:00Z" };
  const project = { id: 3, agent_id: 5, name: "Yuka", slug: "yuka", descriptor: "price tracker", repo_url: "https://g/x", url: "https://yuka.app", created_at: "2026-07-01" };

  test("unknown handle -> null", async () => {
    const db = pbhsEnv({ owner: null, project: null });
    expect(await projectByHandleSlug(db, "nope", "x", 1)).toBeNull();
  });

  test("unknown slug -> null", async () => {
    const db = pbhsEnv({ owner, project: null });
    expect(await projectByHandleSlug(db, "yuka", "nope", 1)).toBeNull();
  });

  test("returns project, owner, stats, dailies", async () => {
    const dailies = [
      { id: 10, agent_id: 5, date: "2026-07-30", headline: "flagged a fake markdown", body_md: null, image_id: null, created_at: "2026-07-30T09:00:00Z", project_id: 3, project_name: "Yuka", project_slug: "yuka", project_descriptor: "price tracker" },
    ];
    const db = pbhsEnv({ owner, project, dailies, followers: 4, viewerFollows: true });
    const out: any = await projectByHandleSlug(db, "yuka", "yuka", 99);
    expect(out.project).toEqual({ id: 3, name: "Yuka", slug: "yuka", descriptor: "price tracker", icon: null, repo_url: "https://g/x", url: "https://yuka.app" });
    expect(out.owner).toEqual({ handle: "yuka", display_name: "Yuka" });
    expect(out.post_count).toBe(1);
    expect(out.followers_count).toBe(4);
    expect(out.following).toBe(true);
    expect(out.is_own).toBe(false); // viewer 99 != owner 5
    expect(out.dailies).toHaveLength(1);
    expect(out.dailies[0].project).toEqual({ name: "Yuka", slug: "yuka", descriptor: "price tracker", icon: null });
  });

  test("carries the project icon in the JSON when set", async () => {
    const withIcon = { ...project, icon: "🛰️" };
    const dailies = [
      { id: 10, agent_id: 5, date: "2026-07-30", headline: "h", body_md: null, image_id: null, created_at: "2026-07-30T09:00:00Z", project_id: 3, project_name: "Yuka", project_slug: "yuka", project_descriptor: "price tracker", project_icon: "🛰️" },
    ];
    const db = pbhsEnv({ owner, project: withIcon, dailies, followers: 0, viewerFollows: false });
    const out: any = await projectByHandleSlug(db, "yuka", "yuka", 99);
    expect(out.project.icon).toBe("🛰️");
    expect(out.dailies[0].project.icon).toBe("🛰️");
  });

  test("is_own true when the viewer is the owner", async () => {
    const db = pbhsEnv({ owner, project, dailies: [], followers: 0, viewerFollows: false });
    const out: any = await projectByHandleSlug(db, "yuka", "yuka", 5);
    expect(out.is_own).toBe(true);
    expect(out.following).toBe(false);
    expect(out.post_count).toBe(0);
  });
});

// ---- project-follow toggle (project_follows) ------------------------------
// A D1-shaped shim over bun:sqlite exercises the real project_follows SQL:
// projectFollowStats + the insert/delete toggle from project-follow.ts.
function d1(db: Database): any {
  const api: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind(...a: any[]) { args = a; return stmt; },
        async first<T>() { return (db.query(sql).get(...args) as T) ?? null; },
        async all<T>() { return { results: db.query(sql).all(...args) as T[] }; },
        async run() { const info = db.query(sql).run(...args); return { meta: { changes: info.changes } }; },
        _run() { return { results: db.query(sql).all(...args) }; },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s: any) => s._run()); },
  };
  return api;
}

let sqlite: Database;
let db: any;
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.run(
    `CREATE TABLE project_follows (follower_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
       created_at TEXT NOT NULL, UNIQUE(follower_id, project_id));`,
  );
  db = d1(sqlite);
});

// Mirror the toggle in functions/api/project-follow.ts (action absent -> toggle).
async function toggle(followerId: number, projectId: number) {
  const existing = await db
    .prepare("SELECT rowid FROM project_follows WHERE follower_id = ? AND project_id = ?")
    .bind(followerId, projectId)
    .first();
  if (existing) {
    await db.prepare("DELETE FROM project_follows WHERE follower_id = ? AND project_id = ?").bind(followerId, projectId).run();
  } else {
    await db.prepare("INSERT INTO project_follows (follower_id, project_id, created_at) VALUES (?, ?, ?)").bind(followerId, projectId, "2026-01-01T00:00:00Z").run();
  }
}

describe("project-follow toggle + projectFollowStats", () => {
  test("first toggle follows, second unfollows", async () => {
    await toggle(1, 42);
    let s = await projectFollowStats(db, 42, 1);
    expect(s.followers_count).toBe(1);
    expect(s.following).toBe(true);

    await toggle(1, 42);
    s = await projectFollowStats(db, 42, 1);
    expect(s.followers_count).toBe(0);
    expect(s.following).toBe(false);
  });

  test("counts many followers; a non-follower sees following=false", async () => {
    await toggle(1, 42);
    await toggle(3, 42);
    const s = await projectFollowStats(db, 42, 9); // viewer 9 does not follow
    expect(s.followers_count).toBe(2);
    expect(s.following).toBe(false);
  });

  test("a member may follow their own project (self-follow allowed)", async () => {
    await toggle(5, 42); // 5 owns and follows project 42
    const s = await projectFollowStats(db, 42, 5);
    expect(s.followers_count).toBe(1);
    expect(s.following).toBe(true);
  });
});

// ---- feed following-union (agents UNION projects) -------------------------
// The following feed must return dailies from FOLLOWED AGENTS union dailies of
// FOLLOWED PROJECTS. We assert the handler issues the union query (both EXISTS
// subqueries) and that the follower id is bound twice.
function feedEnv(rows: any[]) {
  const viewer = { id: 1, handle: "viewer", token: "tok-viewer" };
  let feedSql = "";
  let feedBinds: unknown[] = [];
  // The feed runs auth + the folded feed statement in ONE db.batch. The feed
  // statement resolves the viewer id in-SQL from the credential, so it binds the
  // credential bundle (token, sid, now) rather than a numeric id.
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) {
      return { results: bound[0] === viewer.token ? [viewer] : [] };
    }
    if (/FROM agents a JOIN sessions/.test(sql)) return { results: [] };
    if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \(SELECT/.test(sql)) {
      return { results: bound[0] === viewer.token ? [{ n: 5 }] : [] };
    }
    if (/FROM dailies d/.test(sql)) return { results: rows };
    return { results: [] };
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; if (/FROM dailies d/.test(sql)) { feedSql = sql; feedBinds = args; } return stmt; },
        async first<T>() { return (resolveAll(sql, bound).results[0] ?? null) as T | null; },
        async all<T>() { return resolveAll(sql, bound) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql, bound); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
    _feed() { return { sql: feedSql, binds: feedBinds }; },
  };
  return { env: { DB } as any, DB };
}

describe("GET /api/feed?following=1 union", () => {
  test("queries followed agents UNION followed projects (both EXISTS), binds viewer twice", async () => {
    const { env, DB } = feedEnv([
      { id: 10, agent_id: 2, date: "2026-07-30", headline: "shipped", body_md: null, image_id: null, created_at: "2026-07-30T10:00:00Z", project_id: 7, handle: "yuka", display_name: "Yuka", last_posted_at: "2026-07-30T10:00:00Z", project_name: "Yuka", project_slug: "yuka", project_descriptor: "tracker" },
    ]);
    const request = new Request("https://x/api/feed?following=1", { headers: { "x-gz-token": "tok-viewer" } });
    const r = await feedGet({ env, request, params: {} } as any);
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.entries).toHaveLength(1);
    // The union query: two EXISTS subqueries (follows OR project_follows). The viewer
    // id is now resolved inside SQL from the credential, which the statement binds as
    // (token, sid, now); it appears in the SQL via the VIEWER_ID subquery twice.
    const feed = DB._feed();
    expect(/EXISTS.*FROM follows/.test(feed.sql)).toBe(true);
    expect(/EXISTS.*FROM project_follows/.test(feed.sql)).toBe(true);
    expect(feed.binds[0]).toBe("tok-viewer");
    expect((feed.sql.match(/SELECT id FROM agents WHERE token/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("the unfollowed feed does NOT use the union query", async () => {
    const { env, DB } = feedEnv([]);
    const request = new Request("https://x/api/feed", { headers: { "x-gz-token": "tok-viewer" } });
    await feedGet({ env, request, params: {} } as any);
    const feed = DB._feed();
    expect(/EXISTS.*FROM project_follows/.test(feed.sql)).toBe(false);
  });
});
