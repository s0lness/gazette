import { expect, test, describe } from "bun:test";
import { onRequestPost } from "../functions/api/feedback";

// POST /api/feedback: member-authed via resolveAgent. The MASTER token (agents.token)
// and the human session both resolve; a gzp_ project token is NOT an agents.token, so
// it misses and 401s. source = "api" on the token header, "web" on the session cookie.
// Body {message}: 1..2000 chars (422 otherwise). Cap 10/agent/UTC-day (429).

const AGENT = { id: 7, handle: "sender", token: "tok-agent" };
const SESSION = "sess-human";

function makeDB(opts: { dayCount?: number } = {}) {
  const inserted: unknown[][] = [];
  function resolveFirst(sql: string, bound: unknown[]): any {
    // resolveAgent: agent-by-token (gzp_ tokens are not in agents.token -> miss)
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === AGENT.token ? AGENT : null;
    // agentBySession -> sessions row, then getAgentById
    if (/FROM sessions WHERE id/.test(sql)) {
      return bound[0] === SESSION ? { agent_id: AGENT.id, expires_at: "2999-01-01T00:00:00Z" } : null;
    }
    if (/FROM agents WHERE id/.test(sql)) return bound[0] === AGENT.id ? AGENT : null;
    // per-day feedback COUNT
    if (/COUNT\(\*\) AS n FROM feedback WHERE agent_id/.test(sql)) return { n: opts.dayCount ?? 0 };
    return null;
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async run() {
          if (/INSERT INTO feedback/.test(sql)) inserted.push(bound);
          return { meta: { last_row_id: 42 } };
        },
      };
      return stmt;
    },
    _inserted: inserted,
  };
  return DB;
}

function call(DB: any, cred: { token?: string; session?: string }, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cred.token) headers["x-gz-token"] = cred.token;
  if (cred.session) headers["cookie"] = "gz_session=" + cred.session;
  const request = new Request("https://gazette.sylve.org/api/feedback", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return onRequestPost({ env: { DB } as any, request, params: {} } as any);
}

describe("POST /api/feedback", () => {
  test("token happy path: 200, source api, inserted", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: AGENT.token }, { message: "the 422 didn't say which section was too long" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(DB._inserted.length).toBe(1);
    // bind order: agent_id, source, body, created_at
    expect(DB._inserted[0][0]).toBe(AGENT.id);
    expect(DB._inserted[0][1]).toBe("api");
  });

  test("session happy path: 200, source web", async () => {
    const DB = makeDB();
    const r = await call(DB, { session: SESSION }, { message: "a human complaint relayed verbatim" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
    expect(DB._inserted.length).toBe(1);
    expect(DB._inserted[0][1]).toBe("web");
  });

  test("message is trimmed before storing", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: AGENT.token }, { message: "   padded feedback   " });
    expect(r.status).toBe(200);
    expect(DB._inserted[0][2]).toBe("padded feedback");
  });

  test("empty message is 422", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: AGENT.token }, { message: "   " });
    expect(r.status).toBe(422);
    expect((await r.json() as any).code).toBe("bad_message");
    expect(DB._inserted.length).toBe(0);
  });

  test("over-2000-char message is 422", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: AGENT.token }, { message: "x".repeat(2001) });
    expect(r.status).toBe(422);
    expect(DB._inserted.length).toBe(0);
  });

  test("2000-char message is accepted", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: AGENT.token }, { message: "x".repeat(2000) });
    expect(r.status).toBe(200);
    expect(DB._inserted.length).toBe(1);
  });

  test("11th of the day is 429 rate", async () => {
    const DB = makeDB({ dayCount: 10 });
    const r = await call(DB, { token: AGENT.token }, { message: "one more" });
    expect(r.status).toBe(429);
    expect((await r.json() as any).code).toBe("rate");
    expect(DB._inserted.length).toBe(0);
  });

  test("a gzp_ project token is rejected 401 (not an agents.token)", async () => {
    const DB = makeDB();
    const r = await call(DB, { token: "gzp_deadbeefdeadbeefdeadbeefdeadbeef" }, { message: "should not land" });
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe("gated");
    expect(DB._inserted.length).toBe(0);
  });

  test("no credential is 401", async () => {
    const DB = makeDB();
    const r = await call(DB, {}, { message: "anon" });
    expect(r.status).toBe(401);
    expect(DB._inserted.length).toBe(0);
  });
});
