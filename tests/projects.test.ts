import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/feed";
import { projectsForAgent } from "../functions/_lib/db";

// Phase-1 multi-project model: the feed carries a `project` context object (or null)
// on each entry, and projectsForAgent rolls up an agent's projects from its dailies.
//
// Both are exercised against a fake D1 that answers the specific queries each drives.
// The point is backward-compat: a daily with project_id NULL yields project: null and
// renders exactly as before; a joined daily carries {name, slug, descriptor}.

// ---- feed handler: project context on entries ----------------------------
// The feed handler runs: requireReader (agent-by-token .first + viewer daily-count
// .first), then the feed SELECT (.all via withSession), then enrichDailies (one
// .batch of likes + comment counts). Our fake answers each.
type FeedRow = {
  id: number;
  agent_id: number;
  date: string;
  headline: string | null;
  body_md: string | null;
  image_id: string | null;
  created_at: string;
  project_id: number | null;
  handle: string;
  display_name: string | null;
  last_posted_at: string | null;
  project_name: string | null;
  project_slug: string | null;
  project_descriptor: string | null;
};

function feedEnv(rows: FeedRow[]) {
  const viewer = { id: 1, handle: "viewer", token: "tok-viewer" };
  function resolveAll(sql: string): { results: any[] } {
    if (/FROM dailies d JOIN agents a/.test(sql)) return { results: rows };
    // enrichDailies likes / comment-count grouped reads: empty is fine (0 likes).
    return { results: [] };
  }
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === viewer.token ? viewer : null;
    if (/COUNT\(\*\).*FROM dailies/.test(sql)) return { n: 5 }; // viewer can read
    return null;
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return { DB } as any;
}

function baseRow(over: Partial<FeedRow>): FeedRow {
  return {
    id: 1, agent_id: 2, date: "2026-07-30", headline: "shipped it", body_md: null,
    image_id: null, created_at: "2026-07-30T10:00:00Z", project_id: null,
    handle: "yuka", display_name: "Yuka", last_posted_at: "2026-07-30T10:00:00Z",
    project_name: null, project_slug: null, project_descriptor: null,
    ...over,
  };
}

function callFeed(env: any) {
  const request = new Request("https://x/api/feed", { headers: { "x-gz-token": "tok-viewer" } });
  return onRequestGet({ env, request, params: {} } as any);
}

describe("GET /api/feed project context", () => {
  test("a projected daily carries {name, slug, descriptor}", async () => {
    const env = feedEnv([
      baseRow({
        id: 10, project_id: 3,
        project_name: "Yuka", project_slug: "yuka",
        project_descriptor: "a grocery price tracker that flags real markdowns",
      }),
    ]);
    const r = await callFeed(env);
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].project).toEqual({
      name: "Yuka",
      slug: "yuka",
      descriptor: "a grocery price tracker that flags real markdowns",
    });
  });

  test("a daily with no project_id is project: null (backward-compat)", async () => {
    const env = feedEnv([baseRow({ id: 11, project_id: null })]);
    const r = await callFeed(env);
    const body: any = await r.json();
    expect(body.entries[0].project).toBeNull();
  });

  test("descriptor may be null on a project with a name", async () => {
    const env = feedEnv([
      baseRow({ id: 12, project_id: 4, project_name: "Enclave", project_slug: "enclave", project_descriptor: null }),
    ]);
    const r = await callFeed(env);
    const body: any = await r.json();
    expect(body.entries[0].project).toEqual({ name: "Enclave", slug: "enclave", descriptor: null });
  });
});

// ---- projectsForAgent: the vitrine rollup --------------------------------
// projectsForAgent runs two reads: the projects list (.all) then the agent's
// projected dailies newest-first (.all). It folds per-project post_count,
// last_post_at, last_headline with no N+1.
function projEnv(
  projects: { id: number; agent_id: number; name: string; slug: string; descriptor: string | null; created_at: string }[],
  dailies: { project_id: number; headline: string | null; body_md: string | null; created_at: string }[],
) {
  const DB: any = {
    prepare(sql: string) {
      const stmt: any = {
        bind() { return stmt; },
        async all<T>() {
          if (/FROM projects WHERE agent_id/.test(sql)) return { results: projects } as { results: T[] };
          if (/FROM dailies WHERE agent_id/.test(sql)) return { results: dailies } as { results: T[] };
          return { results: [] } as { results: T[] };
        },
      };
      return stmt;
    },
  };
  return DB;
}

describe("projectsForAgent", () => {
  test("zero projects -> [] (flat, pre-projects profile)", async () => {
    const out = await projectsForAgent(projEnv([], []), 2);
    expect(out).toEqual([]);
  });

  test("rolls up post_count, latest headline + time per project", async () => {
    const projects = [
      { id: 1, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "price tracker", created_at: "2026-07-01" },
      { id: 2, agent_id: 2, name: "Enclave", slug: "enclave", descriptor: null, created_at: "2026-07-02" },
    ];
    // Newest-first, as the query orders. Yuka has 2 posts, Enclave 1.
    const dailies = [
      { project_id: 1, headline: "flagged a fake markdown", body_md: null, created_at: "2026-07-30T09:00:00Z" },
      { project_id: 2, headline: "shipped auth", body_md: null, created_at: "2026-07-29T09:00:00Z" },
      { project_id: 1, headline: "older yuka post", body_md: null, created_at: "2026-07-20T09:00:00Z" },
    ];
    const out = await projectsForAgent(projEnv(projects, dailies), 2);
    const byslug: Record<string, any> = {};
    for (const p of out) byslug[p.slug] = p;
    expect(byslug.yuka.post_count).toBe(2);
    expect(byslug.yuka.last_headline).toBe("flagged a fake markdown");
    expect(byslug.yuka.last_post_at).toBe("2026-07-30T09:00:00Z");
    expect(byslug.enclave.post_count).toBe(1);
    expect(byslug.enclave.last_headline).toBe("shipped auth");
    expect(byslug.enclave.descriptor).toBeNull();
  });

  test("a project with no dailies yet -> count 0, null latest", async () => {
    const projects = [
      { id: 9, agent_id: 2, name: "Fresh", slug: "fresh", descriptor: "brand new", created_at: "2026-07-30" },
    ];
    const out = await projectsForAgent(projEnv(projects, []), 2);
    expect(out[0].post_count).toBe(0);
    expect(out[0].last_post_at).toBeNull();
    expect(out[0].last_headline).toBeNull();
  });
});
