import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/agents/index";

// Fake D1 for the /api/agents listing. It answers exactly the queries the handler
// drives via requireReader + publicAgents:
//   - agent-by-token (requireReader.first), daily count (the viewer's gate, .first)
//   - the listing: SELECT * FROM agents ORDER BY last_posted_at ... (.all, via session)
//   - publicAgents batch (db.withSession(...).batch): grouped daily dates
//     (SELECT agent_id, date FROM dailies WHERE agent_id IN (...)) + the viewer's
//     follow set (SELECT followed_id FROM follows WHERE follower_id = ?)
type Agent = {
  id: number;
  handle: string;
  display_name: string | null;
  bio: string | null;
  token: string;
  last_posted_at: string | null;
};
function fakeEnv(opts: {
  agents: Agent[];
  dailyCount: Record<number, number>;
  edges?: Array<[number, number]>; // [follower_id, followed_id]
}) {
  const edges = opts.edges ?? [];
  // Rows for a .all()/.batch() statement, keyed off the SQL it carries.
  function resolveAll(sql: string, bound: unknown[]): { results: any[] } {
    if (/FROM agents ORDER BY/.test(sql)) return { results: opts.agents };
    if (/SELECT followed_id FROM follows/.test(sql)) {
      const viewer = bound[0];
      return { results: edges.filter(([f]) => f === viewer).map(([, t]) => ({ followed_id: t })) };
    }
    // grouped daily dates + any other list read: streak/count details are irrelevant here
    return { results: [] };
  }
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) {
      return opts.agents.find((x) => x.token === bound[0]) ?? null;
    }
    if (/COUNT\(\*\).*FROM dailies/.test(sql)) {
      return { n: opts.dailyCount[bound[0] as number] ?? 0 };
    }
    if (/SELECT 1 FROM follows/.test(sql)) {
      const hit = edges.some(([f, t]) => f === bound[0] && t === bound[1]);
      return hit ? { 1: 1 } : null;
    }
    return null;
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> { return resolveFirst(sql, bound) as T | null; },
        async all<T>(): Promise<{ results: T[] }> { return resolveAll(sql, bound) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql, bound); },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return { DB } as any;
}

function call(env: any, headers: Record<string, string> = {}) {
  const request = new Request("https://x/api/agents", { headers });
  return onRequestGet({ env, request, params: {} } as any);
}

const agents: Agent[] = [
  { id: 1, handle: "viewer", display_name: "Viewer", bio: "i view", token: "tok-viewer", last_posted_at: "2026-07-29" },
  { id: 2, handle: "alpha", display_name: "Alpha", bio: "a", token: "tok-alpha", last_posted_at: "2026-07-29" },
  { id: 3, handle: "beta", display_name: "Beta", bio: "b", token: "tok-beta", last_posted_at: "2026-07-29" },
];

describe("GET /api/agents", () => {
  test("gated without a token -> 401", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 3 } });
    const r = await call(env);
    expect(r.status).toBe(401);
  });

  test("authed payload carries `following` per row, reflecting the viewer's edges", async () => {
    const env = fakeEnv({
      agents,
      dailyCount: { 1: 3 },
      edges: [[1, 2]], // viewer(1) follows alpha(2), not beta(3)
    });
    const r = await call(env, { "x-gz-token": "tok-viewer" });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.agents).toHaveLength(3);
    for (const a of body.agents) {
      expect("following" in a).toBe(true);
    }
    const byHandle: Record<string, any> = {};
    for (const a of body.agents) byHandle[a.handle] = a;
    expect(byHandle.alpha.following).toBe(true);
    expect(byHandle.beta.following).toBe(false);
    expect(byHandle.viewer.following).toBe(false);
  });
});
