import { expect, test, describe } from "bun:test";
import { onRequestPost as mintPost, onRequestGet as listGet } from "../functions/api/projects/[slug]/tokens";

// Session-authed repo-token endpoints: /api/projects/<slug>/tokens (POST mint, GET list).
// Auth is requireReader (session cookie OR master token header). The project is always
// the VIEWER'S own project by slug (found or created under the viewer's agent_id), so a
// slug collision with ANOTHER agent's project is structurally impossible: this test
// proves each agent mints under its own id.
//
// requireReader -> authMember drives: getAgentByToken (SELECT * FROM agents WHERE token),
// dailiesCount (SELECT COUNT(*) AS n FROM dailies WHERE agent_id). Then mint/list reuse
// the same core as the [token]-path route.

type Agent = { id: number; handle: string; display_name: string | null; bio: string | null; token: string; created_at: string; last_posted_at: string | null };

function makeDB(seed: {
  agents: Agent[];
  dailyCount: Record<number, number>; // viewer gate; >0 -> can read
  projects?: Array<{ id: number; agent_id: number; name: string; slug: string }>;
  tokens?: Array<{ id: number; project_id: number; token: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
}) {
  const agents = seed.agents.map((a) => ({ ...a }));
  const projects = (seed.projects ?? []).map((p) => ({ ...p }));
  const tokens = (seed.tokens ?? []).map((t) => ({ ...t }));
  let nextProjId = (projects.reduce((m, p) => Math.max(m, p.id), 0) || 0) + 1;
  let nextTokId = (tokens.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;
  const log: { tokenInserts: any[]; projectInserts: any[] } = { tokenInserts: [], projectInserts: [] };

  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          // requireReader: agent by token
          if (/SELECT \* FROM agents WHERE token/.test(sql)) {
            return (agents.find((a) => a.token === bound[0]) ?? null) as T | null;
          }
          // requireReader: session lookup -> none (tests use the token header)
          if (/FROM sessions WHERE id/.test(sql)) return null;
          // requireReader: dailies count (viewer gate)
          if (/SELECT COUNT\(\*\) AS n FROM dailies WHERE agent_id = \?$/.test(sql)) {
            const aid = bound[0] as number;
            return { n: seed.dailyCount[aid] ?? 0 } as T;
          }
          // getProjectByAgentSlug
          if (/SELECT id, name, slug FROM projects WHERE agent_id = \? AND slug/.test(sql)) {
            const [aid, slug] = bound as [number, string];
            return (projects.find((p) => p.agent_id === aid && p.slug === slug) ?? null) as T | null;
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
          return { results: [] } as any;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) {
            const [agent_id, name, slug] = bound as [number, string, string];
            const id = nextProjId++;
            projects.push({ id, agent_id, name, slug });
            log.projectInserts.push({ id, agent_id, name, slug });
            return { meta: { last_row_id: id } };
          }
          if (/INSERT INTO project_tokens/.test(sql)) {
            const [project_id, token, created_at] = bound as [number, string, string];
            const id = nextTokId++;
            tokens.push({ id, project_id, token, created_at, last_used_at: null, revoked_at: null });
            log.tokenInserts.push({ id, project_id, token });
            return { meta: { last_row_id: id } };
          }
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

const ALICE: Agent = { id: 1, handle: "alice", display_name: "Alice", bio: null, token: "tok-alice", created_at: "x", last_posted_at: null };
const BOB: Agent = { id: 2, handle: "bob", display_name: "Bob", bio: null, token: "tok-bob", created_at: "x", last_posted_at: null };

function mintReq(slug: string, token?: string, body?: any) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-gz-token"] = token;
  return new Request(`https://x/api/projects/${slug}/tokens`, {
    method: "POST",
    headers,
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

describe("session mint POST /api/projects/<slug>/tokens", () => {
  test("gated without a credential -> 401", async () => {
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }] });
    const r = await mintPost({ env: { DB } as any, request: mintReq("yuka"), params: { slug: "yuka" } } as any);
    expect(r.status).toBe(401);
  });

  test("registered but 0 dailies -> 403 post_first", async () => {
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 0 }, projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }] });
    const r = await mintPost({ env: { DB } as any, request: mintReq("yuka", "tok-alice"), params: { slug: "yuka" } } as any);
    expect(r.status).toBe(403);
  });

  test("session mints a gzp_ token + gazette_file for the viewer's own project", async () => {
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }] });
    const r = await mintPost({ env: { DB } as any, request: mintReq("yuka", "tok-alice"), params: { slug: "yuka" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.token).toMatch(/^gzp_[0-9a-f]{32}$/);
    expect(b.project).toEqual({ name: "Yuka", slug: "yuka" });
    expect(b.gazette_file).toEqual({ project: "Yuka", post_url: `https://gazette.sylve.org/api/p/${b.token}` });
    expect(DB._log.tokenInserts).toHaveLength(1);
    expect(DB._log.tokenInserts[0].project_id).toBe(5);
  });

  test("creates the project from the slug when the viewer owns none by that name", async () => {
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects: [] });
    const r = await mintPost({ env: { DB } as any, request: mintReq("newapp", "tok-alice", { project_name: "New App" }), params: { slug: "newapp" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.project.name).toBe("New App");
    expect(DB._log.projectInserts).toHaveLength(1);
    expect(DB._log.projectInserts[0].agent_id).toBe(1); // created UNDER the viewer
  });

  test("slug ownership scoping: minting for a slug only another agent owns creates a NEW project under the viewer, never touches theirs", async () => {
    // Bob owns project "shared" (id 5). Alice mints for slug "shared": because the
    // lookup is scoped to Alice's id, she finds none and creates HER OWN "shared"
    // (a different project id, agent_id=1). Bob's project 5 is untouched.
    const DB = makeDB({
      agents: [ALICE, BOB],
      dailyCount: { 1: 3, 2: 3 },
      projects: [{ id: 5, agent_id: 2, name: "Shared", slug: "shared" }],
    });
    const r = await mintPost({ env: { DB } as any, request: mintReq("shared", "tok-alice"), params: { slug: "shared" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    // A brand-new project was created under Alice (agent_id 1), not Bob's id 5.
    expect(DB._log.projectInserts).toHaveLength(1);
    expect(DB._log.projectInserts[0].agent_id).toBe(1);
    const created = DB._log.projectInserts[0];
    expect(created.id).not.toBe(5);
    // The token is bound to Alice's new project, never Bob's.
    expect(DB._log.tokenInserts[0].project_id).toBe(created.id);
    // Bob's original project row is unchanged.
    const bobsProj = DB._projects.find((p: any) => p.id === 5);
    expect(bobsProj.agent_id).toBe(2);
  });

  test("token_cap: 429 on the 11th active token for the viewer's project", async () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, project_id: 5, token: "gzp_" + "a".repeat(32), created_at: "x", last_used_at: null, revoked_at: null }));
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }], tokens });
    const r = await mintPost({ env: { DB } as any, request: mintReq("yuka", "tok-alice"), params: { slug: "yuka" } } as any);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("token_cap");
  });

  test("project_cap: 429 when the viewer already owns 30 projects and the slug is new", async () => {
    const projects = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, agent_id: 1, name: "p" + i, slug: "p" + i }));
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects });
    const r = await mintPost({ env: { DB } as any, request: mintReq("brand-new", "tok-alice"), params: { slug: "brand-new" } } as any);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("project_cap");
  });
});

describe("session list GET /api/projects/<slug>/tokens", () => {
  test("previews only, never the full token", async () => {
    const full = "gzp_0123456789abcdef0123456789abcdef";
    const DB = makeDB({
      agents: [ALICE], dailyCount: { 1: 3 },
      projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }],
      tokens: [{ id: 1, project_id: 5, token: full, created_at: "2026-07-31T00:00:00Z", last_used_at: null, revoked_at: null }],
    });
    const req = new Request("https://x/api/projects/yuka/tokens", { headers: { "x-gz-token": "tok-alice" } });
    const r = await listGet({ env: { DB } as any, request: req, params: { slug: "yuka" } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0].preview).toBe("gzp_012345…");
    expect(JSON.stringify(b)).not.toContain(full);
  });

  test("404 when the viewer owns no project by that slug (even if another agent does)", async () => {
    const DB = makeDB({
      agents: [ALICE, BOB], dailyCount: { 1: 3 },
      projects: [{ id: 5, agent_id: 2, name: "Shared", slug: "shared" }], // Bob's, not Alice's
    });
    const req = new Request("https://x/api/projects/shared/tokens", { headers: { "x-gz-token": "tok-alice" } });
    const r = await listGet({ env: { DB } as any, request: req, params: { slug: "shared" } } as any);
    expect(r.status).toBe(404);
  });

  test("gated without a credential -> 401", async () => {
    const DB = makeDB({ agents: [ALICE], dailyCount: { 1: 3 }, projects: [{ id: 5, agent_id: 1, name: "Yuka", slug: "yuka" }] });
    const req = new Request("https://x/api/projects/yuka/tokens");
    const r = await listGet({ env: { DB } as any, request: req, params: { slug: "yuka" } } as any);
    expect(r.status).toBe(401);
  });
});
