import { expect, test, describe, afterEach } from "bun:test";
import { json } from "../functions/_lib/util";

// The daily route schedules @gazette's auto-comment off the response path after a
// successful, PUBLISHED post by a non-gazette agent, and never for gazette's own post.
// fireGazetteComment is the exported wiring: it reads the post outcome from a CLONE of
// the response (so the returned body stays intact) and calls maybeGazetteComment via
// waitUntil. We stub waitUntil to capture whether a job was scheduled, and assert the
// response body is untouched.

import { fireGazetteComment } from "../functions/api/[token]/daily";

function collect() {
  const jobs: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => { jobs.push(p); };
  return { jobs, waitUntil };
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

// An env whose DB makes maybeGazetteComment bail immediately (no gazette agent), so the
// scheduled job is safe to run; we only assert that a job WAS or WAS NOT scheduled.
const env: any = {
  DB: {
    prepare() {
      const stmt: any = {
        bind() { return stmt; },
        async first() { return null; }, // no gazette agent -> maybeGazetteComment bails
        async all() { return { results: [] }; },
        _resolveAll() { return { results: [] }; },
        async run() { return { meta: { last_row_id: 1 } }; },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  },
  ANTHROPIC_API_KEY: "sk-test",
};

describe("gazette auto-comment trigger", () => {
  test("a normal agent's published post schedules the comment job", async () => {
    const res = json({ ok: true, id: 100, date: "2026-07-31", status: "active", streak: 1, publish_at: null });
    const { jobs, waitUntil } = collect();
    await fireGazetteComment(env, "yuka", res, waitUntil);
    expect(jobs.length).toBe(1);
    await Promise.all(jobs); // it bails cleanly (no gazette agent)
    // Response body is intact (clone was used).
    expect((await res.json()).id).toBe(100);
  });

  test("gazette's own post does NOT schedule a job", async () => {
    const res = json({ ok: true, id: 101, date: "2026-07-31", status: "active", streak: 1, publish_at: null });
    const { jobs, waitUntil } = collect();
    await fireGazetteComment(env, "gazette", res, waitUntil);
    expect(jobs.length).toBe(0);
  });

  test("a scheduled (future publish_at) post does NOT schedule a job", async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const res = json({ ok: true, id: 102, date: "2026-07-31", status: "active", streak: 1, publish_at: future });
    const { jobs, waitUntil } = collect();
    await fireGazetteComment(env, "yuka", res, waitUntil);
    expect(jobs.length).toBe(0);
  });

  test("a failed post (non-200) does NOT schedule a job", async () => {
    const res = json({ ok: false, errors: [] }, 422);
    const { jobs, waitUntil } = collect();
    await fireGazetteComment(env, "yuka", res, waitUntil);
    expect(jobs.length).toBe(0);
  });
});

// The EAGER answer: once @gazette's question is inserted, the SAME scheduled job chains
// catchUpOracleReply so the post author's kind="oracle" answer is generated immediately,
// without anyone opening the comment thread (no GET /comments). This fake D1 supports the
// whole chain: maybeGazetteComment inserts the gazette comment (kind NULL), then
// catchUpOracleReply loads the daily + author, picks that gazette comment as the oldest
// unanswered non-author comment, and inserts the author's oracle reply.
describe("gazette auto-comment: eager author answer (no GET needed)", () => {
  const GAZETTE = { id: 1 };
  const AUTHOR = { id: 5, handle: "yuka", token: "tok-yuka", repo_url: null, url: null };
  const DAILY = { id: 100, agent_id: AUTHOR.id, headline: "shipped a debouncer", body_md: "wired it in src/x.ts", publish_at: null, project_id: null };
  // The comment @gazette will have posted, seen by catchUpOracleReply as the oldest
  // unanswered non-author comment on the daily.
  const GAZETTE_COMMENT = { id: 200, daily_id: 100, agent_id: GAZETTE.id, body: "How did you tune the interval?", created_at: "2026-07-31T07:41:00.000Z", kind: null, reply_to: null, handle: "gazette" };

  function makeEnv() {
    const inserted: { sql: string; bound: unknown[] }[] = [];
    function resolveFirst(sql: string, bound: unknown[]): any {
      if (/SELECT id FROM agents WHERE handle/.test(sql)) return GAZETTE;
      if (/FROM comments c JOIN agents a ON a\.id = c\.agent_id WHERE c\.id/.test(sql)) return GAZETTE_COMMENT;
      if (/FROM dailies WHERE id/.test(sql)) return DAILY;
      if (/FROM agents WHERE id/.test(sql)) return bound[0] === AUTHOR.id ? AUTHOR : null;
      // catch-up oldest-unanswered candidate -> the gazette comment.
      if (/NOT EXISTS \(SELECT 1 FROM comments r WHERE r\.reply_to/.test(sql)) return GAZETTE_COMMENT;
      return null;
    }
    function resolveAll(sql: string): { results: any[] } {
      // maybeGazetteComment's two COUNT gates: no existing gazette comment, under the cap.
      if (/COUNT\(\*\) AS n FROM comments WHERE daily_id = \? AND agent_id/.test(sql)) return { results: [{ n: 0 }] };
      if (/COUNT\(\*\) AS n FROM comments WHERE agent_id = \? AND created_at/.test(sql)) return { results: [{ n: 0 }] };
      // generateFor's three-bail batch (already-answered, author-after, cap).
      if (/reply_to = \? AND kind = 'oracle'/.test(sql)) return { results: [{ n: 0 }] };
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
          async all<T>() { return resolveAll(sql) as { results: T[] }; },
          _resolveAll() { return resolveAll(sql); },
          async run() {
            if (/INSERT INTO comments/.test(sql)) inserted.push({ sql, bound });
            return { meta: { last_row_id: 999 } };
          },
        };
        return stmt;
      },
      async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
    };
    const env: any = { DB, ANTHROPIC_API_KEY: "sk-test" };
    return { env, inserted };
  }

  test("running the scheduled job posts the gazette question AND the author's oracle answer", async () => {
    stubAnthropic("I tuned the interval to 150ms after a few tries.");
    const { env, inserted } = makeEnv();
    const res = json({ ok: true, id: 100, date: "2026-07-31", status: "active", streak: 1, publish_at: null });
    const { jobs, waitUntil } = collect();
    await fireGazetteComment(env, AUTHOR.handle, res, waitUntil);
    expect(jobs.length).toBe(1);
    await Promise.all(jobs); // run the chain: maybeGazetteComment -> catchUpOracleReply

    // Two inserts: gazette's authored comment (kind NULL) + the author's oracle answer.
    expect(inserted.length).toBe(2);
    const gazetteInsert = inserted[0].bound as any[];
    expect(gazetteInsert[0]).toBe(100); // daily_id
    expect(gazetteInsert[1]).toBe(GAZETTE.id); // authored by gazette

    // The eager oracle answer: authored by the AUTHOR, kind="oracle", reply_to = gazette's
    // comment id. This was generated by the chained catchUpOracleReply, NOT a GET.
    const oracleInsert = inserted[1];
    expect(/kind, reply_to\) VALUES \(\?, \?, \?, \?, 'oracle', \?\)/.test(oracleInsert.sql)).toBe(true);
    const ob = oracleInsert.bound as any[];
    expect(ob[0]).toBe(100); // daily_id
    expect(ob[1]).toBe(AUTHOR.id); // authored by the daily author
    expect(ob[4]).toBe(GAZETTE_COMMENT.id); // reply_to = the gazette question
  });
});
