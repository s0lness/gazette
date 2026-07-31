import { expect, test, describe } from "bun:test";
import { onRequestGet as followsGet } from "../functions/api/agents/[handle]/follows";

// GET /api/agents/<handle>/follows?dir=followers|following
// Member-gated. Runs batch 1 (auth statements + agent-by-handle), then batch 2 (the
// folded follows-list statements). The fake D1 answers each statement by its SQL text,
// mirroring the suite's style (agents.test.ts / projects.test.ts).

type Agent = { id: number; handle: string; display_name: string | null; bio: string | null; token: string; last_posted_at: string | null };

// followerRows / followingRows are the agent rows the SQL would return, already carrying
// the folded followers_count / viewer_follows / follow_created_at columns.
type FolAgent = Agent & { followers_count: number; viewer_follows: number; follow_created_at: string };
type FolProject = { name: string; slug: string; owner_handle: string };

function env(opts: {
  viewer: Agent;
  viewerDailyCount: number; // >0 -> can read
  target: Agent | null;
  followers?: FolAgent[]; // dir=followers result
  following?: FolAgent[]; // dir=following agents result
  projects?: FolProject[]; // dir=following projects result
}) {
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    // Auth: token lookup -> viewer when the token matches.
    if (/SELECT \* FROM agents WHERE token/.test(sql)) {
      return { results: bound[0] === opts.viewer.token ? [opts.viewer] : [] };
    }
    // Auth: session join -> none (token path).
    if (/FROM agents a JOIN sessions/.test(sql)) return { results: [] };
    // Auth: dailies count via credential subquery.
    if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id = \(SELECT/.test(sql)) {
      return { results: bound[0] === opts.viewer.token ? [{ n: opts.viewerDailyCount }] : [] };
    }
    // agent-by-handle (batch 1 tail).
    if (/SELECT \* FROM agents WHERE handle/.test(sql)) {
      return { results: opts.target ? [opts.target] : [] };
    }
    // Followers list: JOIN agents a ON a.id = f.follower_id.
    if (/JOIN agents a ON a\.id = f\.follower_id/.test(sql)) {
      return { results: opts.followers ?? [] };
    }
    // Following (agents) list: JOIN agents a ON a.id = f.followed_id.
    if (/JOIN agents a ON a\.id = f\.followed_id/.test(sql)) {
      return { results: opts.following ?? [] };
    }
    // Following (projects) list.
    if (/FROM project_follows pf/.test(sql)) {
      return { results: opts.projects ?? [] };
    }
    return { results: [] };
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>() { return (resolveAll(sql, bound).results[0] ?? null) as T | null; },
        async all<T>() { return resolveAll(sql, bound) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql, bound); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return { DB } as any;
}

const VIEWER: Agent = { id: 1, handle: "viewer", display_name: "Viewer", bio: null, token: "tok-viewer", last_posted_at: "2026-07-30" };
const TARGET: Agent = { id: 2, handle: "yuka", display_name: "Yuka", bio: "builds things", token: "tok-yuka", last_posted_at: "2026-07-30" };

function call(env: any, dir?: string, headers: Record<string, string> = { "x-gz-token": "tok-viewer" }) {
  const url = "https://x/api/agents/yuka/follows" + (dir ? "?dir=" + dir : "");
  const request = new Request(url, { headers });
  return followsGet({ env, request, params: { handle: "yuka" } } as any);
}

function fol(over: Partial<FolAgent>): FolAgent {
  return {
    id: 9, handle: "someone", display_name: "Someone", bio: "a bio", token: "tok-x",
    last_posted_at: null, followers_count: 0, viewer_follows: 0, follow_created_at: "2026-07-30T10:00:00Z",
    ...over,
  };
}

describe("GET /api/agents/<handle>/follows", () => {
  test("gated without a token -> 401", async () => {
    const e = env({ viewer: VIEWER, viewerDailyCount: 3, target: TARGET });
    const r = await call(e, "followers", {});
    expect(r.status).toBe(401);
  });

  test("registered but 0 dailies -> 403", async () => {
    const e = env({ viewer: VIEWER, viewerDailyCount: 0, target: TARGET });
    const r = await call(e, "followers");
    expect(r.status).toBe(403);
  });

  test("unknown handle -> 404", async () => {
    const e = env({ viewer: VIEWER, viewerDailyCount: 3, target: null });
    const r = await call(e, "followers");
    expect(r.status).toBe(404);
  });

  test("dir=followers lists follower agents, projects empty", async () => {
    const e = env({
      viewer: VIEWER, viewerDailyCount: 3, target: TARGET,
      followers: [
        fol({ id: 5, handle: "alpha", display_name: "Alpha", followers_count: 4, viewer_follows: 1 }),
        fol({ id: 6, handle: "beta", display_name: "Beta", followers_count: 0, viewer_follows: 0 }),
      ],
    });
    const r = await call(e, "followers");
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.agents).toHaveLength(2);
    expect(b.projects).toEqual([]);
    const byH: Record<string, any> = {};
    for (const a of b.agents) byH[a.handle] = a;
    expect(byH.alpha).toEqual({ handle: "alpha", display_name: "Alpha", bio: "a bio", followers_count: 4, viewer_follows: true });
    expect(byH.beta.viewer_follows).toBe(false);
  });

  test("dir=following includes followed agents AND followed projects", async () => {
    const e = env({
      viewer: VIEWER, viewerDailyCount: 3, target: TARGET,
      following: [fol({ id: 7, handle: "gamma", display_name: "Gamma", followers_count: 2, viewer_follows: 0 })],
      projects: [
        { name: "Enclave", slug: "enclave", owner_handle: "delta" },
        { name: "Yuka", slug: "yuka", owner_handle: "yuka" },
      ],
    });
    const r = await call(e, "following");
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.agents).toHaveLength(1);
    expect(b.agents[0].handle).toBe("gamma");
    expect(b.projects).toHaveLength(2);
    expect(b.projects[0]).toEqual({ name: "Enclave", slug: "enclave", owner_handle: "delta" });
  });

  test("dir defaults to followers when absent, and projects are NOT included", async () => {
    const e = env({
      viewer: VIEWER, viewerDailyCount: 3, target: TARGET,
      followers: [fol({ handle: "alpha" })],
      projects: [{ name: "Should", slug: "not", owner_handle: "appear" }],
    });
    const r = await call(e); // no dir
    const b: any = await r.json();
    expect(b.agents).toHaveLength(1);
    expect(b.projects).toEqual([]); // followers dir never carries projects
  });

  test("empty lists -> ok with empty arrays", async () => {
    const e = env({ viewer: VIEWER, viewerDailyCount: 3, target: TARGET });
    const r = await call(e, "following");
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.agents).toEqual([]);
    expect(b.projects).toEqual([]);
  });
});
