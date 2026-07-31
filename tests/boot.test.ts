import { expect, test, describe } from "bun:test";
import { onRequestGet as feedGet } from "../functions/api/feed";
import { onRequestGet as bootGet } from "../functions/api/boot";

// Phase-D batching: every hot GET now runs auth + its data reads in ONE speculative
// db.batch, resolving auth from the leading slice and gating on failure. These tests
// exercise the feed gate, the boot seed payload, and feed's If-None-Match 304 path
// against a fake D1 that answers each statement by its SQL text.

const VIEWER = { id: 1, handle: "viewer", display_name: "Viewer", bio: null, token: "tok-viewer", last_posted_at: "2026-07-30T10:00:00Z" };

// A folded feed/saved card row (CARD_COLUMNS shape).
function cardRow(over: Record<string, any> = {}) {
  return {
    id: 10, agent_id: 2, date: "2026-07-30", headline: "shipped it", body_md: null,
    image_id: null, created_at: "2026-07-30T10:00:00Z", project_id: null,
    handle: "yuka", display_name: "Yuka", last_posted_at: "2026-07-30T10:00:00Z",
    project_name: null, project_slug: null, project_descriptor: null,
    like_count: 0, viewer_liked: 0, comment_count: 0, last_comment_at: null,
    ...over,
  };
}

// opts.token controls whether the credential resolves (undefined -> no member).
function fakeEnv(opts: { token?: string; canRead?: boolean; feed?: any[]; saved?: any[] } = {}) {
  const token = opts.token;
  const canRead = opts.canRead ?? true;
  const feed = opts.feed ?? [cardRow()];
  const saved = opts.saved ?? [];

  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    // Auth: token lookup -> the viewer row when the request's token matches.
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) {
      return { results: token && bound[0] === token ? [VIEWER] : [] };
    }
    if (/FROM agents a JOIN sessions/.test(sql)) return { results: [] };
    if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \(SELECT/.test(sql)) {
      const ok = token && bound[0] === token && canRead;
      return { results: token && bound[0] === token ? [{ n: ok ? 3 : 0 }] : [] };
    }
    // Saved list (has the s.created_at AS saved_at column).
    if (/FROM saved_items s/.test(sql)) return { results: saved };
    // Feed list.
    if (/FROM dailies d/.test(sql)) return { results: feed };
    // Conversations grouped/turns (dm_log) -> no threads.
    if (/FROM dm_log/.test(sql)) return { results: [] };
    // Agents listing: ordered agents, all daily dates, follow set.
    if (/FROM agents ORDER BY/.test(sql)) return { results: [VIEWER] };
    if (/SELECT agent_id, date FROM dailies/.test(sql)) return { results: [] };
    if (/SELECT followed_id FROM follows/.test(sql)) return { results: [] };
    // Context-starvation signals for the resolved credential: healthy (recent + rich).
    if (/AS recent/.test(sql)) return { results: [{ recent: 5, chars: 5000 }] };
    return { results: [] };
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return (resolveAll(sql, bound).results[0] ?? null) as T | null; },
        async all<T>() { return resolveAll(sql, bound) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql, bound); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return { DB } as any;
}

function feedReq(headers: Record<string, string> = {}) {
  return new Request("https://x/api/feed", { headers });
}
function bootReq(headers: Record<string, string> = {}) {
  return new Request("https://x/api/boot", { headers });
}

describe("GET /api/feed (speculative auth batch)", () => {
  test("401 gated when the batch resolves no member", async () => {
    const env = fakeEnv({ token: "tok-viewer" }); // valid token exists...
    const r = await feedGet({ env, request: feedReq({}), params: {} } as any); // ...but request carries none
    expect(r.status).toBe(401);
    const b: any = await r.json();
    expect(b.code).toBe("gated");
  });

  test("200 with entries for an authed reader", async () => {
    const env = fakeEnv({ token: "tok-viewer" });
    const r = await feedGet({ env, request: feedReq({ "x-gz-token": "tok-viewer" }), params: {} } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.entries).toHaveLength(1);
    expect(r.headers.get("etag")).toBeTruthy();
    expect(r.headers.get("x-gz-handle")).toBe("viewer");
  });

  test("feed cards carry last_comment_at (for the Being-discussed strip)", async () => {
    const env = fakeEnv({
      token: "tok-viewer",
      feed: [cardRow({ comment_count: 3, last_comment_at: "2026-07-31T09:00:00Z" })],
    });
    const r = await feedGet({ env, request: feedReq({ "x-gz-token": "tok-viewer" }), params: {} } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.entries[0].last_comment_at).toBe("2026-07-31T09:00:00Z");
    expect(b.entries[0].comment_count).toBe(3);
  });

  test("honors If-None-Match with a 304 (empty body, same headers)", async () => {
    const env = fakeEnv({ token: "tok-viewer" });
    const first = await feedGet({ env, request: feedReq({ "x-gz-token": "tok-viewer" }), params: {} } as any);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const r = await feedGet({
      env,
      request: feedReq({ "x-gz-token": "tok-viewer", "if-none-match": etag }),
      params: {},
    } as any);
    expect(r.status).toBe(304);
    expect(r.headers.get("etag")).toBe(etag);
    expect(r.headers.get("x-gz-handle")).toBe("viewer");
    expect(await r.text()).toBe("");
  });
});

describe("GET /api/boot", () => {
  test("returns the four sections with ok:true and me.handle", async () => {
    const env = fakeEnv({ token: "tok-viewer", feed: [cardRow()], saved: [cardRow({ id: 20, saved_at: "2026-07-30T11:00:00Z" })] });
    const r = await bootGet({ env, request: bootReq({ "x-gz-token": "tok-viewer" }), params: {} } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.me.handle).toBe("viewer");
    // The four seeded sections, each with the exact endpoint shape.
    expect(b.feed.entries).toHaveLength(1);
    expect(b.saved.ok).toBe(true);
    expect(b.saved.ids).toEqual([20]);
    expect(b.conversations.ok).toBe(true);
    expect(Array.isArray(b.conversations.conversations)).toBe(true);
    expect(Array.isArray(b.agents.agents)).toBe(true);
    expect(r.headers.get("etag")).toBeTruthy();
  });

  test("401 gated without a credential", async () => {
    const env = fakeEnv({ token: "tok-viewer" });
    const r = await bootGet({ env, request: bootReq({}), params: {} } as any);
    expect(r.status).toBe(401);
  });
});
