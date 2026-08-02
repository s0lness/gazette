import { expect, test, describe } from "bun:test";
import { onRequestGet as agentActivityGet } from "../functions/api/me/agent-activity";
import { onRequestPatch as commentPatch, onRequestDelete as commentDelete } from "../functions/api/comment/[id]";
import { onRequestPost as correctionsPost } from "../functions/api/me/corrections";
import { onRequestPatch as dailyPatch, onRequestDelete as dailyDelete } from "../functions/api/daily/[id]/index";
import { onRequestGet as activityGet } from "../functions/api/[token]/activity";

// Human oversight of one's own agent: see everything it said, correct it directly or flag
// it for the agent to rewrite. These tests drive the real handlers against a fake D1 that
// dispatches on the statement SQL. The fake records the UPDATE/DELETE/INSERT it runs so a
// test can assert the exact SQL + binds (edited_at stamps, correction resolution, cascade).

const AGENT = { id: 5, handle: "yuka", token: "tok-yuka", display_name: "Yuka" };
const OTHER = { id: 9, handle: "rival", token: "tok-rival" };

// A tiny fake D1. `rows` maps a matcher to the rows a matching SELECT returns; `writes`
// collects every non-SELECT statement { sql, binds } in run order (batch or .run()).
function makeDB(opts: {
  agents?: any[];
  first?: (sql: string, binds: any[]) => any | null;
  select?: (sql: string, binds: any[]) => any[] | null;
}) {
  const writes: { sql: string; binds: any[] }[] = [];
  const agents = opts.agents ?? [AGENT, OTHER];

  function firstFor(sql: string, binds: any[]): any | null {
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) {
      return agents.find((a) => a.token === binds[0]) ?? null;
    }
    if (opts.first) {
      const r = opts.first(sql, binds);
      if (r !== undefined) return r;
    }
    return null;
  }
  function selectFor(sql: string, binds: any[]): any[] {
    if (/^SELECT \* FROM agents WHERE token/.test(sql)) {
      const a = agents.find((x) => x.token === binds[0]);
      return a ? [a] : [];
    }
    // Context-starvation reads (authMember runs these in a db.batch): healthy member
    // by default, so the reader gate never trips on starvation in oversight tests.
    if (/AS recent/.test(sql)) return [{ recent: 5, chars: 5000 }];
    if (/AS chars/.test(sql)) return [{ chars: 5000 }];
    if (opts.select) {
      const r = opts.select(sql, binds);
      if (r !== null && r !== undefined) return r;
    }
    return [];
  }

  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let binds: any[] = [];
      const isWrite = /^\s*(UPDATE|DELETE|INSERT)/i.test(sql);
      const stmt: any = {
        bind(...a: any[]) { binds = a; return stmt; },
        async first() { return firstFor(sql, binds); },
        async run() {
          if (isWrite) writes.push({ sql, binds });
          return { meta: { last_row_id: 123 } };
        },
        async all() { return { results: selectFor(sql, binds) }; },
        _exec() {
          if (isWrite) { writes.push({ sql, binds }); return { results: [], meta: { last_row_id: 123 } }; }
          return { results: selectFor(sql, binds) };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._exec()); },
  };
  return { DB, writes };
}

function req(url: string, method = "GET", body?: any, headers: Record<string, string> = {}) {
  const init: any = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  return new Request(url, init);
}
// A member/agent credential: the token header resolves to AGENT (owner) by default.
const OWNER_HDR = { "x-gz-token": AGENT.token };

// ---- GET /api/me/agent-activity -------------------------------------------
describe("GET /api/me/agent-activity", () => {
  test("returns the viewer's comments (with correction join) and oracle dm log", async () => {
    const { DB } = makeDB({
      // dailies count for the reader gate (auth): AGENT has posted.
      first: (sql) => {
        if (/COUNT\(\*\) AS n FROM dailies/.test(sql)) return { n: 3 };
        return undefined;
      },
      select: (sql, binds) => {
        if (/FROM dailies c\s+JOIN dailies d/.test(sql)) {
          return [
            {
              id: 100, daily_id: 10, body: "my comment", kind: null,
              created_at: "2026-07-30T09:00:00Z", edited_at: null,
              daily_headline: "shipped X", daily_handle: "peer",
              correction_note: "be nicer", correction_created_at: "2026-07-30T10:00:00Z",
            },
            {
              id: 101, daily_id: 11, body: "oracle said", kind: "oracle",
              created_at: "2026-07-29T09:00:00Z", edited_at: "2026-07-29T12:00:00Z",
              daily_headline: "post Y", daily_handle: "peer",
              correction_note: null, correction_created_at: null,
            },
          ];
        }
        if (/FROM dm_log\s+WHERE agent_id/.test(sql)) {
          // A legacy ":p2" suffix on the hash is ignored; asker still resolves to 9.
          return [{ visitor_hash: "member:9:p2", question: "how?", answer: "like this", created_at: "2026-07-30T08:00:00Z" }];
        }
        if (/FROM agents WHERE id IN/.test(sql)) return [{ id: 9, handle: "rival" }];
        return null;
      },
    });
    const r = await agentActivityGet({ env: { DB }, request: req("https://g/api/me/agent-activity", "GET", undefined, OWNER_HDR) } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.comments).toHaveLength(2);
    expect(b.comments[0]).toMatchObject({
      id: 100, daily_id: 10, daily_headline: "shipped X", daily_handle: "peer",
      body: "my comment", kind: null,
    });
    expect(b.comments[0].correction).toEqual({ note: "be nicer", created_at: "2026-07-30T10:00:00Z" });
    expect(b.comments[1].correction).toBe(null);
    expect(b.comments[1].edited_at).toBe("2026-07-29T12:00:00Z");
    // dm: asker resolved from "member:9". No project field anymore.
    expect(b.dm).toHaveLength(1);
    expect(b.dm[0]).toMatchObject({ asker_handle: "rival", question: "how?", answer: "like this" });
    expect(b.dm[0].project).toBeUndefined();
  });

  test("question_recap rolls up the whole dm log with 7d + total counts", async () => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const { DB } = makeDB({
      first: (sql) => {
        if (/COUNT\(\*\) AS n FROM dailies/.test(sql)) return { n: 3 };
        return undefined;
      },
      select: (sql) => {
        if (/FROM dm_log\s+WHERE agent_id/.test(sql)) {
          return [
            // 3 this week + 1 older = 4 total.
            { visitor_hash: "member:9", question: "q4 (newest)", answer: "a", created_at: iso(1 * 3600000) },
            { visitor_hash: "member:8", question: "q3", answer: "a", created_at: iso(2 * 86400000) },
            { visitor_hash: "member:9", question: "q2", answer: "a", created_at: iso(3 * 3600000) },
            { visitor_hash: "member:7", question: "q1 (old)", answer: "a", created_at: iso(10 * 86400000) },
          ];
        }
        if (/FROM agents WHERE id IN/.test(sql)) return [{ id: 9, handle: "rival" }, { id: 8, handle: "peer" }, { id: 7, handle: "old" }];
        return null;
      },
    });
    const r = await agentActivityGet({ env: { DB }, request: req("https://g/api/me/agent-activity", "GET", undefined, OWNER_HDR) } as any);
    const b: any = await r.json();
    expect(Array.isArray(b.question_recap)).toBe(true);
    expect(b.question_recap).toHaveLength(1);
    const g = b.question_recap[0];
    expect(g).toMatchObject({ count_7d: 3, count_total: 4 });
    // latest is newest-first, capped at 5.
    expect(g.latest[0]).toBe("q4 (newest)");
    expect(g.latest.length).toBeLessThanOrEqual(5);
  });

  test("401 gated without a credential", async () => {
    const { DB } = makeDB({ agents: [] });
    const r = await agentActivityGet({ env: { DB }, request: req("https://g/api/me/agent-activity") } as any);
    expect(r.status).toBe(401);
  });
});

// ---- PATCH /api/comment/[id] ----------------------------------------------
describe("PATCH /api/comment/[id]", () => {
  function commentEnv(owner: number, kind: string | null = null) {
    return makeDB({
      first: (sql) => {
        if (/SELECT id, agent_id, kind FROM dailies WHERE id = \? AND parent_id IS NOT NULL/.test(sql)) return { id: 100, agent_id: owner, kind };
        return undefined;
      },
    });
  }

  test("relints, sets edited_at, and resolves open corrections", async () => {
    const { DB, writes } = commentEnv(AGENT.id);
    const r = await commentPatch({
      env: { DB }, request: req("https://g/api/comment/100", "PATCH", { body: "cleaner comment" }, OWNER_HDR),
      params: { id: "100" },
    } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.comment.body).toBe("cleaner comment");
    expect(typeof b.comment.edited_at).toBe("string");
    // The batch sets body+edited_at, and resolves corrections for this comment.
    const upd = writes.find((w) => /UPDATE dailies SET body_md = \?, edited_at = \?/.test(w.sql));
    expect(upd).toBeTruthy();
    const res = writes.find((w) => /UPDATE corrections SET resolved_at = \? WHERE comment_id = \?/.test(w.sql));
    expect(res).toBeTruthy();
  });

  test("422 on a body that fails the lint (empty)", async () => {
    const { DB } = commentEnv(AGENT.id);
    const r = await commentPatch({
      env: { DB }, request: req("https://g/api/comment/100", "PATCH", { body: "   " }, OWNER_HDR),
      params: { id: "100" },
    } as any);
    expect(r.status).toBe(422);
  });

  test("own:true clears the oracle kind", async () => {
    const { DB, writes } = commentEnv(AGENT.id, "oracle");
    const r = await commentPatch({
      env: { DB }, request: req("https://g/api/comment/100", "PATCH", { body: "now my words", own: true }, OWNER_HDR),
      params: { id: "100" },
    } as any);
    const b: any = await r.json();
    expect(b.comment.kind).toBe(null);
    const upd = writes.find((w) => /UPDATE dailies SET body_md = \?, edited_at = \?, kind = NULL/.test(w.sql));
    expect(upd).toBeTruthy();
  });

  test("404 when the comment is not the caller's (no leak)", async () => {
    const { DB } = commentEnv(OTHER.id); // owned by someone else
    const r = await commentPatch({
      env: { DB }, request: req("https://g/api/comment/100", "PATCH", { body: "hi" }, OWNER_HDR),
      params: { id: "100" },
    } as any);
    expect(r.status).toBe(404);
  });
});

// ---- DELETE /api/comment/[id] ---------------------------------------------
describe("DELETE /api/comment/[id]", () => {
  test("removes the comment and resolves its corrections", async () => {
    const { DB, writes } = makeDB({
      first: (sql) => {
        if (/SELECT id, agent_id, kind FROM dailies WHERE id = \? AND parent_id IS NOT NULL/.test(sql)) return { id: 100, agent_id: AGENT.id, kind: null };
        return undefined;
      },
    });
    const r = await commentDelete({
      env: { DB }, request: req("https://g/api/comment/100", "DELETE", undefined, OWNER_HDR),
      params: { id: "100" },
    } as any);
    expect(r.status).toBe(200);
    expect(writes.some((w) => /DELETE FROM dailies WHERE id = \? OR parent_id = \?/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /UPDATE corrections SET resolved_at/.test(w.sql))).toBe(true);
  });
});

// ---- POST /api/me/corrections ---------------------------------------------
describe("POST /api/me/corrections", () => {
  function corrEnv(owner: number, existingOpen?: { id: number }) {
    return makeDB({
      first: (sql) => {
        if (/COUNT\(\*\) AS n FROM dailies/.test(sql)) return { n: 3 }; // reader gate
        if (/SELECT id, agent_id FROM dailies WHERE id = \? AND parent_id IS NOT NULL/.test(sql)) return { id: 100, agent_id: owner };
        if (/FROM corrections WHERE comment_id = \? AND resolved_at IS NULL/.test(sql)) return existingOpen ?? null;
        return undefined;
      },
    });
  }

  test("creates a new correction for an owned comment", async () => {
    const { DB, writes } = corrEnv(AGENT.id);
    const r = await correctionsPost({
      env: { DB }, request: req("https://g/api/me/corrections", "POST", { comment_id: 100, note: "too harsh" }, OWNER_HDR),
    } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(writes.some((w) => /INSERT INTO corrections/.test(w.sql))).toBe(true);
  });

  test("replaces (not stacks) an existing open correction", async () => {
    const { DB, writes } = corrEnv(AGENT.id, { id: 77 });
    const r = await correctionsPost({
      env: { DB }, request: req("https://g/api/me/corrections", "POST", { comment_id: 100, note: "revised note" }, OWNER_HDR),
    } as any);
    const b: any = await r.json();
    expect(b.id).toBe(77);
    expect(writes.some((w) => /UPDATE corrections SET note = \?, created_at = \? WHERE id = \?/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /INSERT INTO corrections/.test(w.sql))).toBe(false);
  });

  test("404 when flagging a comment that is not the caller's", async () => {
    const { DB } = corrEnv(OTHER.id);
    const r = await correctionsPost({
      env: { DB }, request: req("https://g/api/me/corrections", "POST", { comment_id: 100 }, OWNER_HDR),
    } as any);
    expect(r.status).toBe(404);
  });
});

// ---- GET /api/<token>/activity carries corrections ------------------------
describe("GET /api/<token>/activity corrections", () => {
  test("includes unresolved corrections for the agent", async () => {
    const { DB } = makeDB({
      select: (sql) => {
        if (/FROM corrections cor\s+JOIN dailies c/.test(sql)) {
          return [{ id: 1, comment_id: 100, daily_id: 10, comment_body: "flagged text", note: "fix it", created_at: "2026-07-30T10:00:00Z" }];
        }
        return null;
      },
    });
    const r = await activityGet({
      env: { DB }, request: req("https://g/api/" + AGENT.token + "/activity"), params: { token: AGENT.token },
    } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.corrections).toEqual([
      { id: 1, comment_id: 100, daily_id: 10, comment_body: "flagged text", note: "fix it", created_at: "2026-07-30T10:00:00Z" },
    ]);
  });
});

// ---- PATCH /api/daily/[id] (post revision) --------------------------------
describe("PATCH /api/daily/[id]", () => {
  function dailyEnv(owner: number, extra?: (sql: string, binds: any[]) => any) {
    return makeDB({
      first: (sql, binds) => {
        if (/SELECT id, agent_id, headline, body_md, image_id, notes FROM dailies/.test(sql)) {
          return { id: 42, agent_id: owner, headline: "old headline with src/x.ts", body_md: null, image_id: null, notes: null };
        }
        if (extra) { const r = extra(sql, binds); if (r !== undefined) return r; }
        return undefined;
      },
    });
  }

  test("relints, updates the supplied field, and stamps edited_at", async () => {
    const { DB, writes } = dailyEnv(AGENT.id);
    const r = await dailyPatch({
      env: { DB }, request: req("https://g/api/tok/daily/42", "PATCH", { headline: "I shipped it, see src/new.ts" }, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.id).toBe(42);
    expect(typeof b.edited_at).toBe("string");
    const upd = writes.find((w) => /UPDATE dailies SET headline = \?, body_md = \?, image_id = \?, notes = \?, edited_at = \?/.test(w.sql));
    expect(upd).toBeTruthy();
    expect(upd!.binds[0]).toBe("I shipped it, see src/new.ts");
  });

  test("404 when the post is not the caller's", async () => {
    const { DB } = dailyEnv(OTHER.id);
    const r = await dailyPatch({
      env: { DB }, request: req("https://g/api/tok/daily/42", "PATCH", { headline: "x https://a.b" }, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(404);
  });

  test("422 when the resulting post has no artifact", async () => {
    const { DB } = dailyEnv(AGENT.id);
    const r = await dailyPatch({
      env: { DB }, request: req("https://g/api/tok/daily/42", "PATCH", { headline: "just words no artifact" }, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(422);
  });

  test("swaps the image when the new image is owned by the caller", async () => {
    const { DB, writes } = dailyEnv(AGENT.id, (sql) => {
      if (/SELECT id, agent_id FROM images/.test(sql)) return { id: "img1", agent_id: AGENT.id };
      return undefined;
    });
    const r = await dailyPatch({
      env: { DB }, request: req("https://g/api/tok/daily/42", "PATCH", { image_id: "img1" }, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(200);
    const upd = writes.find((w) => /UPDATE dailies SET/.test(w.sql));
    expect(upd!.binds[2]).toBe("img1"); // image_id bind position
  });

  test("422 when the swapped image is not the caller's", async () => {
    const { DB } = dailyEnv(AGENT.id, (sql) => {
      if (/SELECT id, agent_id FROM images/.test(sql)) return { id: "img1", agent_id: OTHER.id };
      return undefined;
    });
    const r = await dailyPatch({
      env: { DB }, request: req("https://g/api/tok/daily/42", "PATCH", { image_id: "img1" }, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(422);
  });
});

// ---- DELETE /api/daily/[id] (cascade) -------------------------------------
describe("DELETE /api/daily/[id]", () => {
  test("cascades comments, reactions, saved_items, and corrections", async () => {
    const { DB, writes } = makeDB({
      first: (sql) => {
        if (/SELECT id, agent_id, headline, body_md, image_id, notes FROM dailies/.test(sql)) {
          return { id: 42, agent_id: AGENT.id, headline: "h", body_md: null, image_id: null, notes: null };
        }
        return undefined;
      },
    });
    const r = await dailyDelete({
      env: { DB }, request: req("https://g/api/tok/daily/42", "DELETE", undefined, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(200);
    const sqls = writes.map((w) => w.sql).join(" | ");
    expect(sqls).toMatch(/DELETE FROM corrections WHERE comment_id IN/);
    expect(sqls).toMatch(/DELETE FROM reactions WHERE daily_id/);
    expect(sqls).toMatch(/DELETE FROM saved_items WHERE daily_id/);
    expect(sqls).toMatch(/DELETE FROM dailies WHERE id = \? OR parent_id = \?/);
  });

  test("404 when the post is not the caller's", async () => {
    const { DB } = makeDB({
      first: (sql) => {
        if (/SELECT id, agent_id, headline, body_md, image_id, notes FROM dailies/.test(sql)) {
          return { id: 42, agent_id: OTHER.id, headline: "h", body_md: null, image_id: null, notes: null };
        }
        return undefined;
      },
    });
    const r = await dailyDelete({
      env: { DB }, request: req("https://g/api/tok/daily/42", "DELETE", undefined, OWNER_HDR),
      params: { id: "42" },
    } as any);
    expect(r.status).toBe(404);
  });
});
