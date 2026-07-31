import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/daily/[id]/comments";

// The comment-thread GET carries kind (null = authored, "oracle" = generated) and
// reply_to (the comment id an oracle reply answers) on every row, so the client can
// render the oracle chip + the "replying to @who" prefix. It also fires a lazy catch-up
// pass via waitUntil; we pass a waitUntil stub and assert it was scheduled but the
// RESPONSE itself is unchanged (no new row appears in this response).

const VIEWER = { id: 9, handle: "reader", token: "tok-reader" };

function makeEnv(rows: any[]) {
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === VIEWER.token ? VIEWER : null;
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 1 }; // canRead gate
    // catch-up loadDaily / candidate: no author found -> catch-up bails harmlessly
    return null;
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() {
          if (/FROM comments c JOIN agents a/.test(sql)) return { results: rows } as { results: T[] };
          return { results: [] } as { results: T[] };
        },
      };
      return stmt;
    },
  };
  return { DB, ANTHROPIC_API_KEY: "sk-test" } as any;
}

function call(env: any, id = 100, scheduled?: Promise<unknown>[]) {
  const request = new Request("https://gazette.sylve.org/api/daily/100/comments", {
    headers: { "x-gz-token": VIEWER.token },
  });
  const waitUntil = scheduled ? (p: Promise<unknown>) => scheduled.push(p) : undefined;
  return onRequestGet({ env, request, params: { id: String(id) }, waitUntil } as any);
}

describe("comments GET carries kind + reply_to", () => {
  test("rows include kind and reply_to", async () => {
    const rows = [
      { id: 1, handle: "asker", body: "how did you test it?", created_at: "2026-07-30T10:00:00Z", kind: null, reply_to: null },
      { id: 2, handle: "yuka", body: "I tested it twice.", created_at: "2026-07-30T11:00:00Z", kind: "oracle", reply_to: 1 },
    ];
    const env = makeEnv(rows);
    const r = await call(env);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.comments.length).toBe(2);
    expect(b.comments[0].kind).toBe(null);
    expect(b.comments[0].reply_to).toBe(null);
    expect(b.comments[1].kind).toBe("oracle");
    expect(b.comments[1].reply_to).toBe(1);
  });

  test("a lazy catch-up pass is scheduled via waitUntil (response unchanged)", async () => {
    const rows = [
      { id: 1, handle: "asker", body: "q", created_at: "2026-07-30T10:00:00Z", kind: null, reply_to: null },
    ];
    const scheduled: Promise<unknown>[] = [];
    const env = makeEnv(rows);
    const r = await call(env, 100, scheduled);
    const b: any = await r.json();
    expect(b.comments.length).toBe(1); // the response carries exactly what was in the DB
    expect(scheduled.length).toBe(1); // one catch-up pass was scheduled
    await scheduled[0]; // it resolves without throwing (author not found -> bails)
  });
});
