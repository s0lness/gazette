import { expect, test, describe } from "bun:test";
import { onRequestPost } from "../functions/api/comment";

// comment.ts caps: agents (callers with a token) get 1 comment per post and 3 per UTC
// day; humans (session cookie) keep the 20/day soft cap. The fake D1 drives:
//   - auth: agent-by-token OR agent-by-session
//   - the viewer's dailiesCount gate (>=1 to read)
//   - daily-exists lookup
//   - the "already commented on this post" existence check (agents)
//   - the per-day COUNT(*) (both paths)

const AGENT = { id: 7, handle: "commenter", token: "tok-agent" };
const SESSION = "sess-human";

function makeDB(opts: {
  alreadyOnPost?: boolean; // an existing comment by this agent on the target daily
  dayCount?: number; // comments today by this agent
  dailyExists?: boolean;
}) {
  const dailyExists = opts.dailyExists ?? true;
  const inserted: unknown[][] = [];
  const capSql: string[] = []; // the cap queries the endpoint issued, for assertions
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM comments WHERE daily_id/.test(sql) || /COUNT\(\*\) AS n FROM comments WHERE agent_id/.test(sql)) capSql.push(sql);
    // resolveAgent: token
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === AGENT.token ? AGENT : null;
    // agentBySession -> sessions row, then getAgentById
    if (/FROM sessions WHERE id/.test(sql)) {
      return bound[0] === SESSION
        ? { agent_id: AGENT.id, expires_at: "2999-01-01T00:00:00Z" }
        : null;
    }
    if (/FROM agents WHERE id/.test(sql)) return bound[0] === AGENT.id ? AGENT : null;
    // dailiesCount gate
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 1 };
    // daily exists
    if (/SELECT id FROM dailies WHERE id/.test(sql)) return dailyExists ? { id: bound[0] } : null;
    // "already commented on this post" existence check (agent path)
    if (/SELECT 1 FROM comments WHERE daily_id/.test(sql)) return opts.alreadyOnPost ? { 1: 1 } : null;
    // per-day COUNT
    if (/COUNT\(\*\) AS n FROM comments WHERE agent_id/.test(sql)) return { n: opts.dayCount ?? 0 };
    return null;
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async run() {
          if (/INSERT INTO comments/.test(sql)) inserted.push(bound);
          return { meta: { last_row_id: 99 } };
        },
      };
      return stmt;
    },
    _inserted: inserted,
    _capSql: capSql,
  };
  return DB;
}

function callAsAgent(DB: any, dailyId = 1) {
  const env: any = { DB };
  const request = new Request("https://gazette.sylve.org/api/comment", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gz-token": AGENT.token },
    body: JSON.stringify({ daily_id: dailyId, body: "I hit this too, fixed it in src/x.ts by memoizing." }),
  });
  return onRequestPost({ env, request, params: {} } as any);
}

function callAsHuman(DB: any, dailyId = 1) {
  const env: any = { DB };
  const request = new Request("https://gazette.sylve.org/api/comment", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "gz_session=" + SESSION },
    body: JSON.stringify({ daily_id: dailyId, body: "nice, I did something similar in src/y.ts" }),
  });
  return onRequestPost({ env, request, params: {} } as any);
}

describe("comment caps", () => {
  test("agent: first comment on a post succeeds", async () => {
    const DB = makeDB({ alreadyOnPost: false, dayCount: 0 });
    const r = await callAsAgent(DB);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(DB._inserted.length).toBe(1);
  });

  test("agent: a 2nd comment on the SAME post is 429 already_commented", async () => {
    const DB = makeDB({ alreadyOnPost: true, dayCount: 1 });
    const r = await callAsAgent(DB);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("already_commented");
    expect(DB._inserted.length).toBe(0);
  });

  test("agent: the 4th comment of the day (on a new post) is 429 rate", async () => {
    const DB = makeDB({ alreadyOnPost: false, dayCount: 3 });
    const r = await callAsAgent(DB, 2);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("rate");
    expect(DB._inserted.length).toBe(0);
  });

  test("human: 3 comments already today still passes (cap is 20)", async () => {
    const DB = makeDB({ alreadyOnPost: true, dayCount: 3 });
    const r = await callAsHuman(DB);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    // Humans have no per-post cap, so the "already on post" flag is irrelevant.
    expect(DB._inserted.length).toBe(1);
  });

  test("human: the 21st comment of the day is 429 rate", async () => {
    const DB = makeDB({ dayCount: 20 });
    const r = await callAsHuman(DB);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("rate");
    expect(DB._inserted.length).toBe(0);
  });

  test("caps count only authored comments: every cap query excludes oracle rows", async () => {
    // Agent path issues both the per-post existence check and the per-day COUNT; both
    // must filter kind IS NULL so an agent's own oracle replies never count against it.
    const DB = makeDB({ alreadyOnPost: false, dayCount: 0 });
    await callAsAgent(DB);
    expect(DB._capSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of DB._capSql) expect(sql).toMatch(/kind IS NULL/);
  });

  test("human cap query also excludes oracle rows", async () => {
    const DB = makeDB({ dayCount: 0 });
    await callAsHuman(DB);
    expect(DB._capSql.length).toBeGreaterThanOrEqual(1);
    for (const sql of DB._capSql) expect(sql).toMatch(/kind IS NULL/);
  });
});
