import { expect, test, describe } from "bun:test";
import { onRequestGet, onRequestPost } from "../functions/api/admin/feedback";

// /api/admin/feedback: same gate as admin/stats (Cf-Access-Jwt-Assertion OR ADMIN_KEY).
// GET lists newest-first with the joined handle; POST {ids} marks read_at.

const SECRET = "s3cr3t-admin-key";

function fakeEnv(rows: any[], adminKey: string | undefined) {
  const marked: unknown[][] = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async all<T>() {
          if (/FROM feedback f LEFT JOIN agents/.test(sql)) return { results: rows } as { results: T[] };
          return { results: [] } as { results: T[] };
        },
        async run() {
          if (/UPDATE feedback SET read_at/.test(sql)) {
            marked.push(bound);
            // changes = number of ids passed (all unread in these fixtures)
            return { meta: { changes: bound.length - 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    _marked: marked,
  };
  return { DB, ADMIN_KEY: adminKey } as any;
}

function callGet(env: any, opts: { key?: string; access?: boolean } = {}) {
  const qs = opts.key != null ? "?key=" + encodeURIComponent(opts.key) : "";
  const headers: Record<string, string> = {};
  if (opts.access) headers["cf-access-jwt-assertion"] = "stub.jwt";
  const request = new Request("https://x/api/admin/feedback" + qs, { headers });
  return onRequestGet({ env, request, params: {} } as any);
}

function callPost(env: any, ids: unknown, opts: { key?: string; access?: boolean } = {}) {
  const qs = opts.key != null ? "?key=" + encodeURIComponent(opts.key) : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.access) headers["cf-access-jwt-assertion"] = "stub.jwt";
  const request = new Request("https://x/api/admin/feedback" + qs, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids }),
  });
  return onRequestPost({ env, request, params: {} } as any);
}

const ROWS = [
  { id: 3, handle: "sender", source: "api", body: "newest", created_at: "2026-07-31T10:00:00Z", read_at: null },
  { id: 2, handle: null, source: "web", body: "no handle", created_at: "2026-07-30T09:00:00Z", read_at: null },
  { id: 1, handle: "sender", source: "api", body: "read one", created_at: "2026-07-29T09:00:00Z", read_at: "2026-07-30T00:00:00Z" },
];

describe("GET /api/admin/feedback gate", () => {
  test("401 keyless with no Access", async () => {
    const r = await callGet(fakeEnv(ROWS, SECRET));
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("unauthorized");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("200 with the right key", async () => {
    const r = await callGet(fakeEnv(ROWS, SECRET), { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.feedback.length).toBe(3);
    // newest first, joined handle, null handle preserved
    expect(b.feedback[0]).toEqual({ id: 3, handle: "sender", source: "api", body: "newest", created_at: "2026-07-31T10:00:00Z", read_at: null });
    expect(b.feedback[1].handle).toBe(null);
  });

  test("200 behind Cloudflare Access with no key", async () => {
    const r = await callGet(fakeEnv(ROWS, undefined), { access: true });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/admin/feedback mark-read", () => {
  test("401 keyless", async () => {
    const r = await callPost(fakeEnv(ROWS, SECRET), [2, 3]);
    expect(r.status).toBe(401);
  });

  test("marks the given ids, returns updated count", async () => {
    const env = fakeEnv(ROWS, SECRET);
    const r = await callPost(env, [2, 3], { key: SECRET });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.updated).toBe(2);
    // bound = [now, ...ids]
    expect(env.DB._marked.length).toBe(1);
    expect(env.DB._marked[0].slice(1)).toEqual([2, 3]);
  });

  test("empty ids is a no-op 200 with updated 0", async () => {
    const env = fakeEnv(ROWS, SECRET);
    const r = await callPost(env, [], { key: SECRET });
    expect(r.status).toBe(200);
    expect((await r.json() as any).updated).toBe(0);
    expect(env.DB._marked.length).toBe(0);
  });

  test("non-integer ids are filtered out", async () => {
    const env = fakeEnv(ROWS, SECRET);
    const r = await callPost(env, ["x", -1, 5], { key: SECRET });
    expect(r.status).toBe(200);
    // only 5 survives
    expect(env.DB._marked[0].slice(1)).toEqual([5]);
  });
});
