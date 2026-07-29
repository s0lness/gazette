import { expect, test, describe } from "bun:test";
import { authMember, tokenFromRequest, resolveAgent } from "../functions/_lib/auth";

// A minimal fake D1 so we can exercise auth without a live database. It answers the
// queries auth drives: agent-by-token, agent-by-id, session lookup, and daily count.
function fakeEnv(opts: {
  agents: Array<{ id: number; handle: string; token: string }>;
  dailyCount: Record<number, number>;
  sessions?: Record<string, { agent_id: number; expires_at: string }>;
}) {
  const sessions = opts.sessions ?? {};
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (/FROM agents WHERE token/.test(sql)) {
            const a = opts.agents.find((x) => x.token === bound[0]);
            return (a ?? null) as T | null;
          }
          if (/FROM agents WHERE id/.test(sql)) {
            const a = opts.agents.find((x) => x.id === bound[0]);
            return (a ?? null) as T | null;
          }
          if (/FROM sessions WHERE id/.test(sql)) {
            const s = sessions[bound[0] as string];
            return (s ?? null) as unknown as T | null;
          }
          if (/COUNT\(\*\).*FROM dailies/.test(sql)) {
            const n = opts.dailyCount[bound[0] as number] ?? 0;
            return { n } as unknown as T;
          }
          return null;
        },
      };
      return stmt;
    },
  };
  return { DB } as any;
}

function req(headers: Record<string, string>) {
  return new Request("https://x/api/feed", { headers });
}

function future(days = 1) {
  return new Date(Date.now() + days * 86400000).toISOString();
}
function past(days = 1) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

describe("tokenFromRequest", () => {
  test("reads x-gz-token", () => {
    expect(tokenFromRequest(req({ "x-gz-token": "abc" }))).toBe("abc");
  });
  test("reads Authorization Bearer", () => {
    expect(tokenFromRequest(req({ authorization: "Bearer def" }))).toBe("def");
  });
  test("null when absent", () => {
    expect(tokenFromRequest(req({}))).toBeNull();
  });
});

describe("authMember canRead", () => {
  const agents = [
    { id: 1, handle: "poster", token: "tok-poster" },
    { id: 2, handle: "empty", token: "tok-empty" },
  ];
  const env = fakeEnv({ agents, dailyCount: { 1: 3, 2: 0 } });

  test("unknown token -> null", async () => {
    expect(await authMember(env, req({ "x-gz-token": "nope" }))).toBeNull();
  });
  test("no token -> null", async () => {
    expect(await authMember(env, req({}))).toBeNull();
  });
  test("member with dailies can read", async () => {
    const m = await authMember(env, req({ "x-gz-token": "tok-poster" }));
    expect(m).not.toBeNull();
    expect(m!.canRead).toBe(true);
    expect(m!.agent.handle).toBe("poster");
  });
  test("registered but zero dailies cannot read", async () => {
    const m = await authMember(env, req({ "x-gz-token": "tok-empty" }));
    expect(m).not.toBeNull();
    expect(m!.canRead).toBe(false);
  });
});

describe("resolveAgent: cookie OR token", () => {
  const agents = [{ id: 1, handle: "poster", token: "tok-poster" }];

  test("token header resolves the agent", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 1 } });
    const a = await resolveAgent(env, req({ "x-gz-token": "tok-poster" }));
    expect(a!.handle).toBe("poster");
  });

  test("valid session cookie resolves the agent", async () => {
    const env = fakeEnv({
      agents,
      dailyCount: { 1: 1 },
      sessions: { "sess-abc": { agent_id: 1, expires_at: future() } },
    });
    const a = await resolveAgent(env, req({ cookie: "gz_session=sess-abc" }));
    expect(a!.handle).toBe("poster");
  });

  test("expired session cookie does not resolve", async () => {
    const env = fakeEnv({
      agents,
      dailyCount: { 1: 1 },
      sessions: { "sess-old": { agent_id: 1, expires_at: past() } },
    });
    const a = await resolveAgent(env, req({ cookie: "gz_session=sess-old" }));
    expect(a).toBeNull();
  });

  test("unknown session cookie does not resolve", async () => {
    const env = fakeEnv({ agents, dailyCount: { 1: 1 }, sessions: {} });
    const a = await resolveAgent(env, req({ cookie: "gz_session=nope" }));
    expect(a).toBeNull();
  });

  test("cookie also unlocks reads through authMember", async () => {
    const env = fakeEnv({
      agents,
      dailyCount: { 1: 2 },
      sessions: { "sess-abc": { agent_id: 1, expires_at: future() } },
    });
    const m = await authMember(env, req({ cookie: "gz_session=sess-abc" }));
    expect(m).not.toBeNull();
    expect(m!.canRead).toBe(true);
  });

  test("token wins when both present", async () => {
    const two = [
      { id: 1, handle: "poster", token: "tok-poster" },
      { id: 2, handle: "other", token: "tok-other" },
    ];
    const env = fakeEnv({
      agents: two,
      dailyCount: { 1: 1, 2: 1 },
      sessions: { "sess-2": { agent_id: 2, expires_at: future() } },
    });
    const a = await resolveAgent(
      env,
      req({ "x-gz-token": "tok-poster", cookie: "gz_session=sess-2" }),
    );
    expect(a!.handle).toBe("poster");
  });
});
