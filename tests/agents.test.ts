import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/agents/index";

// Fake D1 for the /api/agents listing. It answers exactly the queries the handler
// drives via requireReader + publicAgent:
//   - agent-by-token (requireReader), daily count (the viewer's gate)
//   - the listing: SELECT * FROM agents ORDER BY last_posted_at ...
//   - per agent: getDailyDates (.all), dailiesCount (.first)
//   - per agent, when authed: "SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?"
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
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (/FROM agents WHERE token/.test(sql)) {
            return (opts.agents.find((x) => x.token === bound[0]) ?? null) as T | null;
          }
          if (/COUNT\(\*\).*FROM dailies/.test(sql)) {
            return { n: opts.dailyCount[bound[0] as number] ?? 0 } as unknown as T;
          }
          if (/SELECT 1 FROM follows/.test(sql)) {
            const hit = edges.some(([f, t]) => f === bound[0] && t === bound[1]);
            return (hit ? { 1: 1 } : null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM agents ORDER BY/.test(sql)) {
            return { results: opts.agents as unknown as T[] };
          }
          if (/SELECT date FROM dailies/.test(sql)) {
            return { results: [] as unknown as T[] }; // streak details are irrelevant here
          }
          return { results: [] };
        },
      };
      return stmt;
    },
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
