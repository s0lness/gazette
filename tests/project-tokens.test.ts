import { expect, test, describe } from "bun:test";
import { onRequestPost as mintPost, onRequestGet as listGet } from "../functions/api/[token]/projects/[slug]/tokens";
import { onRequestDelete as revokeDelete } from "../functions/api/[token]/projects/[slug]/tokens/[id]";
import { onRequestPost as pDailyPost } from "../functions/api/p/[ptoken]/daily";
import { privacyLint } from "../functions/_lib/lint";

// Project tokens: mint / list / revoke on the master-token routes, and the write-only
// /api/p/<gzp> daily path. Each test drives a fake D1 that answers exactly the queries
// the code issues, mirroring the existing suite's style.

const MASTER = "tok-master";
const AGENT = { id: 2, handle: "yuka", display_name: "Yuka", bio: null, token: MASTER, created_at: "x", last_posted_at: null };

// A fake D1 backing agents, projects, project_tokens, dailies (for caps). Seed the
// stores; the DB records inserts/updates so tests can assert.
function makeDB(seed: {
  projects?: Array<{ id: number; agent_id: number; name: string; slug: string }>;
  tokens?: Array<{ id: number; project_id: number; token: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
  dailiesToday?: number; // how many beats already CREATED today (the daily-create cap tally)
} = {}) {
  const projects = (seed.projects ?? []).map((p) => ({ ...p }));
  const tokens = (seed.tokens ?? []).map((t) => ({ ...t }));
  let createdToday = seed.dailiesToday ?? 0;
  let nextProjId = (projects.reduce((m, p) => Math.max(m, p.id), 0) || 0) + 1;
  let nextTokId = (tokens.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;
  const log: { tokenInserts: any[]; dailyInserts: any[]; tokenUpdates: any[] } = {
    tokenInserts: [],
    dailyInserts: [],
    tokenUpdates: [],
  };

  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          // agent by token
          if (/SELECT \* FROM agents WHERE token/.test(sql)) return (bound[0] === MASTER ? AGENT : null) as T | null;
          // agent by id (resolveProjectToken)
          if (/SELECT \* FROM agents WHERE id/.test(sql)) return (bound[0] === AGENT.id ? AGENT : null) as T | null;
          // resolveProjectToken join
          if (/FROM project_tokens pt JOIN projects p/.test(sql)) {
            const t = tokens.find((x) => x.token === bound[0]);
            if (!t) return null;
            const p = projects.find((x) => x.id === t.project_id)!;
            return {
              token_id: t.id,
              revoked_at: t.revoked_at,
              project_id: p.id,
              project_name: p.name,
              project_slug: p.slug,
              agent_id: p.agent_id,
            } as T;
          }
          // getProjectByAgentSlug
          if (/SELECT id, name, slug, icon FROM projects WHERE agent_id = \? AND slug/.test(sql)) {
            const [aid, slug] = bound as [number, string];
            const p = projects.find((p) => p.agent_id === aid && p.slug === slug);
            return (p ? { id: p.id, name: p.name, slug: p.slug, icon: (p as any).icon ?? null } : null) as T | null;
          }
          // findOrCreateProject existing lookup
          if (/SELECT id, name, descriptor.*FROM projects WHERE agent_id = \? AND slug/.test(sql)) {
            const [aid, slug] = bound as [number, string];
            const p = projects.find((x) => x.agent_id === aid && x.slug === slug);
            return (p ? { id: p.id, name: p.name, descriptor: null, repo_url: null, url: null } : null) as T | null;
          }
          // projectCountForAgent
          if (/COUNT\(\*\) AS n FROM projects WHERE agent_id/.test(sql)) {
            const aid = bound[0] as number;
            return { n: projects.filter((p) => p.agent_id === aid).length } as T;
          }
          // activeProjectTokenCount
          if (/COUNT\(\*\) AS n FROM project_tokens WHERE project_id = \? AND revoked_at IS NULL/.test(sql)) {
            const pid = bound[0] as number;
            return { n: tokens.filter((t) => t.project_id === pid && t.revoked_at === null).length } as T;
          }
          // revokeProjectToken existence
          if (/SELECT id, revoked_at FROM project_tokens WHERE id = \? AND project_id/.test(sql)) {
            const [tid, pid] = bound as [number, number];
            const t = tokens.find((x) => x.id === tid && x.project_id === pid);
            return (t ? { id: t.id, revoked_at: t.revoked_at } : null) as T | null;
          }
          // dailiesCreatedToday (the daily-create cap tally): COUNT of today's rows.
          if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \? AND date/.test(sql)) {
            return { n: createdToday } as T;
          }
          // image lookup (postDaily) -> none
          if (/FROM images WHERE id/.test(sql)) return null;
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // listProjectTokens
          if (/SELECT id, token, created_at, last_used_at, revoked_at FROM project_tokens WHERE project_id/.test(sql)) {
            const pid = bound[0] as number;
            const rows = tokens
              .filter((t) => t.project_id === pid)
              .map((t) => ({ id: t.id, token: t.token, created_at: t.created_at, last_used_at: t.last_used_at, revoked_at: t.revoked_at }));
            return { results: rows } as any;
          }
          // computeStreak reads daily dates
          if (/SELECT date FROM dailies/.test(sql)) return { results: [{ date: "2026-07-31" }] } as any;
          return { results: [] } as any;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) {
            const [agent_id, name, slug] = bound as [number, string, string];
            const id = nextProjId++;
            projects.push({ id, agent_id, name, slug });
            return { meta: { last_row_id: id } };
          }
          if (/INSERT INTO project_tokens/.test(sql)) {
            const [project_id, token, created_at] = bound as [number, string, string];
            const id = nextTokId++;
            tokens.push({ id, project_id, token, created_at, last_used_at: null, revoked_at: null });
            log.tokenInserts.push({ id, project_id, token });
            return { meta: { last_row_id: id } };
          }
          if (/UPDATE project_tokens SET revoked_at/.test(sql)) {
            const now = bound[0] as string;
            const id = bound[1] as number;
            const t = tokens.find((x) => x.id === id);
            if (t && t.revoked_at === null) t.revoked_at = now;
            log.tokenUpdates.push({ id, revoked_at: now });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE project_tokens SET last_used_at/.test(sql)) return { meta: { changes: 1 } };
          if (/INSERT INTO dailies/.test(sql)) {
            log.dailyInserts.push(bound);
            createdToday += 1;
            return { meta: { last_row_id: 100 } };
          }
          if (/UPDATE agents SET last_posted_at/.test(sql)) return { meta: {} };
          return { meta: {} };
        },
      };
      return stmt;
    },
    _projects: projects,
    _tokens: tokens,
    _log: log,
  };
  return DB;
}

function mintReq(body?: any) {
  return new Request("https://x/api/tok-master/projects/yuka/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("mint POST /api/<master>/projects/<slug>/tokens", () => {
  test("mints a gzp_ token + gazette_file for an existing project", async () => {
    const DB = makeDB({ projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }] });
    const r = await mintPost({ env: { DB } as any, request: mintReq(), params: { token: MASTER, slug: "yuka" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.token).toMatch(/^gzp_[0-9a-f]{32}$/);
    expect(b.project).toEqual({ name: "Yuka", slug: "yuka", icon: null });
    expect(b.gazette_file.project).toBe("Yuka");
    expect(b.gazette_file.post_url).toBe(`https://gazette.sylve.org/api/p/${b.token}`);
    expect(DB._log.tokenInserts).toHaveLength(1);
  });

  test("creates the project from the slug when it does not exist", async () => {
    const DB = makeDB({ projects: [] });
    const r = await mintPost({ env: { DB } as any, request: mintReq({ project_name: "Yuka", project_descriptor: "a price tracker" }), params: { token: MASTER, slug: "yuka" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.project).toEqual({ name: "Yuka", slug: "yuka", icon: null });
    expect(DB._projects).toHaveLength(1);
  });

  test("token_cap: 429 on the 11th active token", async () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, project_id: 5, token: "gzp_" + "a".repeat(32), created_at: "x", last_used_at: null, revoked_at: null }));
    const DB = makeDB({ projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }], tokens });
    const r = await mintPost({ env: { DB } as any, request: mintReq(), params: { token: MASTER, slug: "yuka" } } as any);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("token_cap");
  });

  test("project_cap: 429 when the agent already owns 30 projects and the slug is new", async () => {
    const projects = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, agent_id: 2, name: "p" + i, slug: "p" + i }));
    const DB = makeDB({ projects });
    const r = await mintPost({ env: { DB } as any, request: mintReq(), params: { token: MASTER, slug: "brand-new" } } as any);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("project_cap");
  });

  test("unknown master token -> 404", async () => {
    const DB = makeDB();
    const r = await mintPost({ env: { DB } as any, request: mintReq(), params: { token: "nope", slug: "yuka" } } as any);
    expect(r.status).toBe(404);
  });
});

describe("list GET /api/<master>/projects/<slug>/tokens", () => {
  test("previews only, never the full token", async () => {
    const full = "gzp_0123456789abcdef0123456789abcdef";
    const DB = makeDB({
      projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: full, created_at: "2026-07-31T00:00:00Z", last_used_at: null, revoked_at: null }],
    });
    const req = new Request("https://x/api/tok-master/projects/yuka/tokens");
    const r = await listGet({ env: { DB } as any, request: req, params: { token: MASTER, slug: "yuka" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0].preview).toBe("gzp_012345…");
    expect(JSON.stringify(b)).not.toContain(full);
  });
});

describe("revoke DELETE /api/<master>/projects/<slug>/tokens/<id>", () => {
  function delReq() {
    return new Request("https://x/api/tok-master/projects/yuka/tokens/1", { method: "DELETE" });
  }
  test("revokes and is idempotent", async () => {
    const DB = makeDB({
      projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: "gzp_x", created_at: "x", last_used_at: null, revoked_at: null }],
    });
    const first = await revokeDelete({ env: { DB } as any, request: delReq(), params: { token: MASTER, slug: "yuka", id: "1" } } as any);
    expect(first.status).toBe(200);
    expect(DB._tokens[0].revoked_at).not.toBeNull();
    // Idempotent second call: still ok, no second update.
    const second = await revokeDelete({ env: { DB } as any, request: delReq(), params: { token: MASTER, slug: "yuka", id: "1" } } as any);
    expect(second.status).toBe(200);
    const b: any = await second.json();
    expect(b.ok).toBe(true);
    expect(DB._log.tokenUpdates).toHaveLength(1); // only the first actually wrote
  });

  test("unknown token id -> 404", async () => {
    const DB = makeDB({ projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }] });
    const r = await revokeDelete({ env: { DB } as any, request: delReq(), params: { token: MASTER, slug: "yuka", id: "99" } } as any);
    expect(r.status).toBe(404);
  });
});

function pDailyReq(ptoken: string, payload: any) {
  return new Request(`https://x/api/p/${ptoken}/daily`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("write-only POST /api/p/<gzp>/daily", () => {
  const gzp = "gzp_0123456789abcdef0123456789abcdef";
  function db() {
    return makeDB({
      projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: gzp, created_at: "x", last_used_at: null, revoked_at: null }],
    });
  }

  test("posts under the forced project; payload project field ignored", async () => {
    const DB = db();
    const r = await pDailyPost({ env: { DB } as any, request: pDailyReq(gzp, {
      headline: "I shipped the price diff in commit a1b2c3d4e5f6",
      project: "some-other-project", // must be ignored
    }), params: { ptoken: gzp } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.project).toEqual({ name: "Yuka", slug: "yuka" });
    // The daily INSERT binds project_id (position 5) = the FORCED project id 5.
    expect(DB._log.dailyInserts[0][5]).toBe(5);
  });

  test("unknown token -> 401 unknown_token", async () => {
    const DB = db();
    const r = await pDailyPost({ env: { DB } as any, request: pDailyReq("gzp_deadbeef", { headline: "x src/a.ts" }), params: { ptoken: "gzp_deadbeef" } } as any);
    expect(r.status).toBe(401);
    const b: any = await r.json();
    expect(b.code).toBe("unknown_token");
  });

  test("revoked token -> 401 revoked", async () => {
    const DB = makeDB({
      projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: gzp, created_at: "x", last_used_at: null, revoked_at: "2026-07-31T00:00:00Z" }],
    });
    const r = await pDailyPost({ env: { DB } as any, request: pDailyReq(gzp, { headline: "x src/a.ts" }), params: { ptoken: gzp } } as any);
    expect(r.status).toBe(401);
    const b: any = await r.json();
    expect(b.code).toBe("revoked");
    expect(b.message).toMatch(/human/i);
  });

  test("daily_cap: 429 on the 9th beat of the day (8 already created)", async () => {
    // 8 beats already CREATED today: the create cap (milestones coexist, so the cap is
    // a flat per-day count, not a distinct-project rule).
    const DB = makeDB({
      projects: [{ id: 5, agent_id: 2, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: gzp, created_at: "x", last_used_at: null, revoked_at: null }],
      dailiesToday: 8,
    });
    const r = await pDailyPost({ env: { DB } as any, request: pDailyReq(gzp, { headline: "I shipped x, see src/a.ts" }), params: { ptoken: gzp } } as any);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("daily_cap");
  });
});

describe("lint rejects a gzp_ token in the body", () => {
  test("privacyLint flags a gzp_ project token", () => {
    const r = privacyLint("posting with gzp_0123456789abcdef0123456789abcdef oops");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "privacy" && /project token/i.test(e.message))).toBe(true);
  });
});
