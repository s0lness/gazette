import { expect, test, describe } from "bun:test";
import { onRequestGet } from "../functions/api/card/[handle]";

// Fake D1 for the card handler. It answers exactly the queries the endpoint drives:
//   - requireReader: agent-by-token, daily count (for the viewer)
//   - getAgentByHandle: agent-by-handle (the card target)
//   - followStats: two COUNT(*) FROM follows + one "SELECT 1 FROM follows" existence
type Agent = { id: number; handle: string; display_name: string | null; bio: string | null; token: string };
function fakeEnv(opts: {
  agents: Agent[];
  dailyCount: Record<number, number>;
  followers?: Record<number, number>;
  followingCount?: Record<number, number>;
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
          if (/FROM agents WHERE id/.test(sql)) {
            return (opts.agents.find((x) => x.id === bound[0]) ?? null) as T | null;
          }
          if (/FROM agents WHERE handle/.test(sql)) {
            return (opts.agents.find((x) => x.handle === bound[0]) ?? null) as T | null;
          }
          if (/COUNT\(\*\).*FROM dailies/.test(sql)) {
            return { n: opts.dailyCount[bound[0] as number] ?? 0 } as unknown as T;
          }
          if (/COUNT\(\*\).*FROM follows WHERE followed_id/.test(sql)) {
            return { n: (opts.followers ?? {})[bound[0] as number] ?? 0 } as unknown as T;
          }
          if (/COUNT\(\*\).*FROM follows WHERE follower_id/.test(sql)) {
            return { n: (opts.followingCount ?? {})[bound[0] as number] ?? 0 } as unknown as T;
          }
          if (/SELECT 1 FROM follows/.test(sql)) {
            const hit = edges.some(([f, t]) => f === bound[0] && t === bound[1]);
            return (hit ? { 1: 1 } : null) as unknown as T | null;
          }
          return null;
        },
      };
      return stmt;
    },
  };
  return { DB } as any;
}

function call(env: any, handle: string, headers: Record<string, string> = {}) {
  const request = new Request("https://x/api/card/" + handle, { headers });
  return onRequestGet({ env, request, params: { handle } } as any);
}

const agents: Agent[] = [
  { id: 1, handle: "viewer", display_name: "Viewer", bio: "i view", token: "tok-viewer" },
  { id: 2, handle: "target", display_name: "Target Agent", bio: "builds things", token: "tok-target" },
];

describe("GET /api/card/[handle]", () => {
  test("gated without a token -> 401", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 3, 2: 1 } });
    const r = await call(env, "target");
    expect(r.status).toBe(401);
  });

  test("unknown handle -> 404", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 3 } });
    const r = await call(env, "nope", { "x-gz-token": "tok-viewer" });
    expect(r.status).toBe(404);
  });

  test("returns the light card shape (no dailies) with follow state", async () => {
    const env = fakeEnv({
      agents,
      dailyCount: { 1: 3 },
      followers: { 2: 5 },
      followingCount: { 2: 2 },
      edges: [[1, 2]], // viewer(1) follows target(2)
    });
    const r = await call(env, "target", { "x-gz-token": "tok-viewer" });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body).toEqual({
      handle: "target",
      display_name: "Target Agent",
      bio: "builds things",
      followers_count: 5,
      following_count: 2,
      following: true,
      is_self: false,
    });
    // Light endpoint: it must NOT carry posts.
    expect("dailies" in body).toBe(false);
  });

  test("is_self true when viewing your own card", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 3 }, followers: { 1: 0 }, followingCount: { 1: 0 } });
    const r = await call(env, "viewer", { "x-gz-token": "tok-viewer" });
    const body: any = await r.json();
    expect(body.is_self).toBe(true);
    expect(body.following).toBe(false);
  });
});
