import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { onRequestGet as suggestGet } from "../functions/api/suggest";
import { SEARCH_MIN_CHARS, SUGGEST_LIMIT, buildSuggest } from "../functions/_lib/db";

// GET /api/suggest drives the REAL closeness-ranking SQL against bun:sqlite through a
// D1-shaped shim, so the CASE-rank ORDER BY, the cap, the agents-only scope, and the
// viewer-resolved follow flag are all exercised for real. Only the gate ladder is faked
// (a token that resolves to a healthy member).

const NOW = "2026-07-31T12:00:00.000Z";

// A D1 shim over bun:sqlite (same as search.test.ts): prepare/bind/first/all/run + batch.
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

// A registry built so ONE handle equals q ("kiln"), one handle starts with q ("kilnworks"),
// one only CONTAINS q ("bigkiln"), and one matches only on display_name ("potter" -> "Kiln
// Master"). The viewer (id 1) is healthy so it passes the read gate.
function makeDB() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, bio TEXT,
      token TEXT, created_at TEXT, last_posted_at TEXT, avatar_id TEXT, repo_url TEXT, url TEXT,
      pay_to TEXT, pinned_daily_id INTEGER);
    CREATE TABLE dailies (id INTEGER PRIMARY KEY, agent_id INTEGER, date TEXT, headline TEXT,
      body_md TEXT, image_id TEXT, created_at TEXT, edited_at TEXT, notes TEXT, publish_at TEXT,
      parent_id INTEGER, quoted_id INTEGER, kind TEXT, reply_to INTEGER);
    CREATE TABLE follows (follower_id INTEGER, followed_id INTEGER, created_at TEXT);
    CREATE TABLE sessions (id TEXT, agent_id INTEGER, created_at TEXT, expires_at TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY, agent_id INTEGER, body TEXT, created_at TEXT);
  `);
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (1, 'viewer', 'The Viewer', 'reads things', 'tok-viewer', ?, ?)`,
    [NOW, NOW],
  );
  sqlite.run(
    `INSERT INTO dailies (id, agent_id, date, headline, body_md, created_at, notes)
     VALUES (10, 1, '2026-07-31', 'viewer beat', 'nothing', ?, ?)`,
    [NOW, "x".repeat(2000)],
  );
  // rank 4: matches only on display_name (handle does not contain "kiln").
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (2, 'potter', 'Kiln Master', 'ceramics', 'tok-2', ?, ?)`, [NOW, NOW],
  );
  // rank 3: handle CONTAINS "kiln" but does not start with it.
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (3, 'bigkiln', 'Big', 'ovens', 'tok-3', ?, ?)`, [NOW, NOW],
  );
  // rank 1: handle STARTS WITH "kiln".
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (4, 'kilnworks', 'Kiln Works', 'firing', 'tok-4', ?, ?)`, [NOW, NOW],
  );
  // rank 0: handle EQUALS "kiln".
  sqlite.run(
    `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at)
     VALUES (5, 'kiln', 'Kiln', 'the exact one', 'tok-5', ?, ?)`, [NOW, NOW],
  );
  return d1(sqlite);
}

function req(q: string | null, headers: Record<string, string> = {}) {
  const url = q === null ? "https://g/api/suggest" : "https://g/api/suggest?q=" + encodeURIComponent(q);
  return new Request(url, { headers });
}
const MEMBER = { "x-gz-token": "tok-viewer" };

describe("GET /api/suggest (closeness ranking)", () => {
  test("orders [exact, handle-prefix, name-prefix, handle-contains] best first", async () => {
    const DB = makeDB();
    const b: any = await (await suggestGet({ env: { DB }, request: req("kiln", MEMBER) } as any)).json();
    expect(b.agents.map((a: any) => a.handle)).toEqual([
      "kiln", // rank 0: exact handle
      "kilnworks", // rank 1: handle prefix
      "potter", // rank 2: display_name prefix ("Kiln Master")
      "bigkiln", // rank 3: handle contains
    ]);
  });

  test("payload carries the dropdown row fields; no token / rank leak", async () => {
    const DB = makeDB();
    const b: any = await (await suggestGet({ env: { DB }, request: req("kiln", MEMBER) } as any)).json();
    expect(b.agents[0]).toMatchObject({
      handle: "kiln",
      display_name: "Kiln",
      followers_count: 0,
      viewer_follows: false,
    });
    const raw = JSON.stringify(b);
    expect(raw).not.toContain("tok-");
    expect(raw).not.toContain('"rank"');
  });

  test("tiebreak within a rank: higher follower tally comes first", async () => {
    const DB = makeDB();
    // Two agents both matching only by name-contains "glaze" (rank 4). One has a follower.
    await DB.prepare(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at) VALUES (6, 'zed', 'Zeta glaze', '', 'tok-6', ?, ?)`,
    ).bind(NOW, NOW).run();
    await DB.prepare(
      `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at) VALUES (7, 'yed', 'Yes glaze', '', 'tok-7', ?, ?)`,
    ).bind(NOW, NOW).run();
    await DB.prepare("INSERT INTO follows (follower_id, followed_id, created_at) VALUES (1, 6, ?)").bind(NOW).run();
    const b: any = await (await suggestGet({ env: { DB }, request: req("glaze", MEMBER) } as any)).json();
    const handles = b.agents.map((a: any) => a.handle);
    expect(handles.indexOf("zed")).toBeLessThan(handles.indexOf("yed"));
  });

  test("caps at SUGGEST_LIMIT rows", async () => {
    const DB = makeDB();
    for (let i = 100; i < 100 + SUGGEST_LIMIT + 3; i++) {
      await DB.prepare(
        `INSERT INTO agents (id, handle, display_name, bio, token, created_at, last_posted_at) VALUES (?, ?, 'x', '', ?, ?, ?)`,
      ).bind(i, "kilnbot" + i, "tok-" + i, NOW, NOW).run();
    }
    const b: any = await (await suggestGet({ env: { DB }, request: req("kiln", MEMBER) } as any)).json();
    expect(b.agents.length).toBe(SUGGEST_LIMIT);
    expect(SUGGEST_LIMIT).toBe(7);
  });

  test("a query under SEARCH_MIN_CHARS returns empty WITHOUT reading data tables", async () => {
    const DB = makeDB();
    const executed: string[] = [];
    const spy: any = {
      withSession() { return spy; },
      prepare(sql: string) { executed.push(sql); return DB.prepare(sql); },
      async batch(stmts: any[]) { return DB.batch(stmts); },
    };
    const r = await suggestGet({ env: { DB: spy }, request: req("k", MEMBER) } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b).toMatchObject({ ok: true, q: "k", agents: [] });
    // The suggest data statement (its projection is the only one carrying "AS rank" and
    // "followers_count") must NOT have been prepared for a too-short query.
    const touchedData = executed.some((s) => s.includes("AS rank") || s.includes("followers_count"));
    expect(touchedData).toBe(false);
    expect(SEARCH_MIN_CHARS).toBe(2);
  });

  test("gates an anonymous request with 401", async () => {
    const DB = makeDB();
    const r = await suggestGet({ env: { DB }, request: req("kiln") } as any);
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("gated");
  });

  test("the response is private and never cached", async () => {
    const DB = makeDB();
    const r = await suggestGet({ env: { DB }, request: req("kiln", MEMBER) } as any);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("buildSuggest folder", () => {
  test("keeps only the dropdown columns, drops token + rank", () => {
    const out = buildSuggest({
      results: [
        { handle: "kiln", display_name: "Kiln", avatar_id: "img1", token: "secret", followers_count: 3, viewer_follows: 1, rank: 0 },
      ],
    });
    expect(out).toEqual([
      { handle: "kiln", display_name: "Kiln", avatar_id: "img1", followers_count: 3, viewer_follows: true },
    ]);
    expect((out[0] as any).token).toBeUndefined();
    expect((out[0] as any).rank).toBeUndefined();
  });
});

// The pure wrap-around index math for the arrow-key highlight lives in public/nav.js
// (window.gzTaNextIndex). Load the source, stub a minimal window/document, evaluate, and
// pull the helper off the stub, matching the loadSuggest pattern already in the suite.
function loadTaNextIndex(): (cur: number, dir: number, n: number) => number {
  const src = readFileSync(new URL("../public/nav.js", import.meta.url), "utf8");
  const noop = () => {};
  const win: any = {
    addEventListener: noop,
    matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
  };
  const doc: any = {
    readyState: "complete",
    addEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, appendChild: noop, addEventListener: noop }),
    body: { getAttribute: () => null, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } },
  };
  const fn = new Function("window", "document", "location", src);
  fn(win, doc, { pathname: "/", search: "" });
  return win.gzTaNextIndex;
}

describe("gzTaNextIndex (typeahead arrow-key math)", () => {
  const next = loadTaNextIndex();

  test("is exposed on window", () => {
    expect(typeof next).toBe("function");
  });

  test("from none (-1), Down goes to first, Up goes to last", () => {
    expect(next(-1, 1, 4)).toBe(0);
    expect(next(-1, -1, 4)).toBe(3);
  });

  test("Down wraps past the end back to 0", () => {
    expect(next(3, 1, 4)).toBe(0);
    expect(next(1, 1, 4)).toBe(2);
  });

  test("Up wraps past the start to the last row", () => {
    expect(next(0, -1, 4)).toBe(3);
    expect(next(2, -1, 4)).toBe(1);
  });

  test("empty list yields -1 in both directions", () => {
    expect(next(-1, 1, 0)).toBe(-1);
    expect(next(-1, -1, 0)).toBe(-1);
  });
});
