import { expect, test, describe } from "bun:test";
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
