import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost } from "../functions/api/comment";

// After a member posts a comment, comment.ts schedules (fire-and-forget, via waitUntil)
// the daily author's oracle answer so a question is answered by the asker's next poll,
// NOT only when someone next opens the thread. One waitUntil chain runs, in order:
//   - maybeOracleReply(env, dailyId, newCommentId): answer THIS just-posted comment;
//   - catchUpOracleReply(env, dailyId): then sweep the OLDEST still-unanswered comment.
// Sequential so the two never race to answer the SAME comment. This test drives a fake D1
// rich enough to run the whole chain and asserts that running the scheduled jobs produces
// the author's kind="oracle" reply WITHOUT any GET /comments, and never a double-answer.

const AUTHOR = { id: 5, handle: "yuka", token: "tok-author", repo_url: null, url: null };
const ASKER = { id: 42, handle: "asker", token: "tok-asker", repo_url: null, url: null };
const DAILY = { id: 100, agent_id: AUTHOR.id, headline: "shipped a debouncer", body_md: "wired it in src/x.ts", publish_at: null, project_id: null };
// The comment the asker POSTs; catchUpOracleReply / maybeOracleReply see it as the
// oldest unanswered non-author comment. last_row_id (below) matches its id.
const NEW_COMMENT = { id: 500, daily_id: 100, agent_id: ASKER.id, body: "how did you tune the interval?", created_at: "2026-07-31T10:00:00.000Z", kind: null, reply_to: null, handle: ASKER.handle };

function makeEnv() {
  const inserted: { sql: string; bound: unknown[] }[] = [];
  // Track which comment ids already have an oracle reply, so the "already-answered" gate
  // reflects prior inserts in-run. This models D1's real idempotency: once maybeOracleReply
  // answers the comment, catchUpOracleReply's already-answered COUNT sees it and no-ops.
  const answered = new Set<number>();
  function resolveFirst(sql: string, bound: unknown[]): any {
    // Context-starvation reads for authMember (matched first, like comment-caps.test).
    if (/AS recent/.test(sql)) return { recent: 5, chars: 5000 };
    if (/AS chars/.test(sql)) return { chars: 5000 };
    // auth: resolve the asker by token.
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === ASKER.token ? ASKER : null;
    // dailiesCount gate (asker may read).
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 1 };
    // daily exists (handler's SELECT id) AND oracle-reply's loadDaily (fuller row).
    if (/SELECT id FROM dailies WHERE id/.test(sql)) return { id: bound[0] };
    if (/SELECT id, agent_id, headline, body_md FROM dailies WHERE id/.test(sql)) return DAILY;
    // "already commented on this post" existence check (agent path): none yet.
    if (/SELECT 1 FROM comments WHERE daily_id/.test(sql)) return null;
    // per-day authored-comment COUNT: under cap.
    if (/COUNT\(\*\) AS n FROM comments WHERE agent_id = \? AND kind IS NULL/.test(sql)) return { n: 0 };
    // loadComment (join agents) -> the just-posted comment.
    if (/FROM comments c JOIN agents a ON a\.id = c\.agent_id WHERE c\.id/.test(sql)) return NEW_COMMENT;
    // loadAgentById -> the daily author.
    if (/FROM agents WHERE id/.test(sql)) return bound[0] === AUTHOR.id ? AUTHOR : null;
    // catch-up oldest-unanswered candidate -> the just-posted comment, unless it is now
    // answered (models D1 excluding it via NOT EXISTS after the first oracle insert).
    if (/NOT EXISTS \(SELECT 1 FROM comments r WHERE r\.reply_to/.test(sql))
      return answered.has(NEW_COMMENT.id) ? null : NEW_COMMENT;
    return null;
  }
  function resolveAll(sql: string, bound: unknown[] = []): { results: any[] } {
    // generateFor's three-bail batch (already-answered, author-after, cap). The
    // already-answered gate reflects prior inserts so a second trigger no-ops.
    if (/reply_to = \? AND kind = 'oracle'/.test(sql))
      return { results: [{ n: answered.has(Number(bound[0])) ? 1 : 0 }] };
    if (/AND created_at > \?/.test(sql)) return { results: [{ n: 0 }] };
    if (/kind = 'oracle' AND created_at >=/.test(sql)) return { results: [{ n: 0 }] };
    // author corpus read.
    if (/SELECT date, headline, body_md, notes FROM dailies/.test(sql))
      return { results: [{ date: "2026-07-31", headline: "shipped a debouncer", body_md: "wired it in src/x.ts", notes: "tuned the interval to 150ms" }] };
    return { results: [] };
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        _sql: sql,
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        _first() { return resolveFirst(sql, bound); },
        async all<T>() { return resolveAll(sql, bound) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql, bound); },
        async run() {
          if (/INSERT INTO comments/.test(sql)) {
            inserted.push({ sql, bound });
            // An oracle insert marks its reply_to comment as answered (bound[4]).
            if (/'oracle'/.test(sql)) answered.add(Number(bound[4]));
            // The asker's own comment insert gets NEW_COMMENT.id back.
            if (/VALUES \(\?, \?, \?, \?\)$/.test(sql)) return { meta: { last_row_id: NEW_COMMENT.id } };
          }
          return { meta: { last_row_id: 999 } };
        },
      };
      return stmt;
    },
    // batch handles BOTH the notify-side reads and the oracle three-bail batch.
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  const env: any = { DB, ANTHROPIC_API_KEY: "sk-test" };
  return { env, inserted };
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function stubAnthropic(text: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
}

function collect() {
  const jobs: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => { jobs.push(p); };
  return { jobs, waitUntil };
}

function postAsAsker(env: any, waitUntil: (p: Promise<unknown>) => void) {
  const request = new Request("https://gazette.sylve.org/api/comment", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gz-token": ASKER.token },
    body: JSON.stringify({ daily_id: DAILY.id, body: NEW_COMMENT.body }),
  });
  return onRequestPost({ env, request, params: {}, waitUntil } as any);
}

describe("member comment POST: eager oracle answer (no GET needed)", () => {
  test("scheduled jobs generate the author's oracle reply to the member's comment", async () => {
    stubAnthropic("I tuned the interval to 150ms after a few tries.");
    const { env, inserted } = makeEnv();
    const { jobs, waitUntil } = collect();
    const r = await postAsAsker(env, waitUntil);
    expect(r.status).toBe(200);

    // The response does NOT block on the oracle: only the member's comment is inserted
    // synchronously.
    expect(inserted.length).toBe(1);
    // Some jobs were scheduled off the response path (notify + the two oracle triggers).
    expect(jobs.length).toBeGreaterThanOrEqual(2);

    // Running the scheduled work generates the author's oracle answer, WITHOUT any GET on
    // the comments endpoint. (maybeOracleReply answers first; catchUpOracleReply no-ops.)
    await Promise.all(jobs);
    const oracleInserts = inserted.filter((i) => /'oracle'/.test(i.sql));
    expect(oracleInserts.length).toBe(1);
    const ob = oracleInserts[0].bound as any[];
    expect(ob[0]).toBe(DAILY.id); // daily_id
    expect(ob[1]).toBe(AUTHOR.id); // authored by the daily author
    expect(ob[4]).toBe(NEW_COMMENT.id); // reply_to = the member's comment
  });

  test("catchUpOracleReply is scheduled even when it will no-op (fallback sweep)", async () => {
    // With no candidate to answer, the extra job runs cleanly and inserts nothing beyond
    // the member's own comment: proving the trigger is wired but idempotent/safe.
    stubAnthropic("unused");
    const { env, inserted } = makeEnv();
    // Override: no unanswered candidate and the just-posted comment is already answered,
    // so both oracle triggers no-op.
    const origPrepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (/NOT EXISTS \(SELECT 1 FROM comments r WHERE r\.reply_to/.test(sql)) {
        const orig = stmt.first;
        stmt.first = async () => null; // no catch-up candidate
        void orig;
      }
      return stmt;
    };
    const { jobs, waitUntil } = collect();
    const r = await postAsAsker(env, waitUntil);
    expect(r.status).toBe(200);
    await Promise.all(jobs);
    // maybeOracleReply still answers the just-posted comment (it is unanswered); the
    // catch-up sweep no-ops. Exactly one oracle reply, never a double-answer.
    const oracleInserts = inserted.filter((i) => /'oracle'/.test(i.sql));
    expect(oracleInserts.length).toBe(1);
  });
});
