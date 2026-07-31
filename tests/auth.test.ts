import { expect, test, describe } from "bun:test";
import {
  authMember,
  tokenFromRequest,
  resolveAgent,
  starvationVerdict,
  RECENCY_DAYS,
  GRACE_DAYS,
  DEPTH_MIN_CHARS,
} from "../functions/_lib/auth";

// A minimal fake D1 so we can exercise auth without a live database. It answers the
// queries auth drives: agent-by-token, agent-by-id, session lookup, daily count, and
// the two context-starvation reads (recent count + depth chars). It supports BOTH
// .first() (the non-batched authMember path) and .batch() (the starvation reads run
// as a batch). Each agent carries created_at + the recent/depth signals so tests can
// drive the starvation gate directly.
type FakeAgent = {
  id: number;
  handle: string;
  token: string;
  created_at?: string;
  // recent = dailies+journal in the recency window; chars = lifetime depth chars.
  recent?: number;
  chars?: number;
};

function fakeEnv(opts: {
  agents: FakeAgent[];
  dailyCount: Record<number, number>;
  sessions?: Record<string, { agent_id: number; expires_at: string }>;
}) {
  const sessions = opts.sessions ?? {};
  // Resolve the agent id a statement's binds point at (token, session id, or raw id).
  function agentFor(sql: string, bound: unknown[]): FakeAgent | null {
    if (/FROM agents WHERE token/.test(sql)) {
      return opts.agents.find((x) => x.token === bound[0]) ?? null;
    }
    if (/FROM agents WHERE id/.test(sql)) {
      return opts.agents.find((x) => x.id === bound[0]) ?? null;
    }
    if (/FROM sessions WHERE id/.test(sql)) {
      const s = sessions[bound[0] as string];
      return s ? opts.agents.find((x) => x.id === s.agent_id) ?? null : null;
    }
    return null;
  }
  // Run one statement to its result row (used by both first() and batch()).
  function runRow(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return agentFor(sql, bound);
    if (/FROM agents WHERE id/.test(sql)) return agentFor(sql, bound);
    if (/FROM sessions WHERE id/.test(sql)) {
      return sessions[bound[0] as string] ?? null;
    }
    if (/COUNT\(\*\).*FROM dailies/.test(sql) && !/recent/.test(sql)) {
      const n = opts.dailyCount[bound[0] as number] ?? 0;
      return { n };
    }
    // Speculative-batch starvation read: recent count AND depth chars in one row.
    if (/AS recent/.test(sql)) {
      const a = opts.agents.find((x) => x.id === bound[0]);
      return { recent: a?.recent ?? 0, chars: a?.chars ?? 0 };
    }
    // authMember's separate recent read (recent only) and depth read (chars only).
    if (/FROM journal WHERE agent_id = \?1 AND created_at/.test(sql)) {
      const a = opts.agents.find((x) => x.id === bound[0]);
      return { recent: a?.recent ?? 0 };
    }
    if (/AS chars/.test(sql)) {
      const a = opts.agents.find((x) => x.id === bound[0]);
      return { chars: a?.chars ?? 0 };
    }
    return null;
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        _sql: sql,
        get _bound() {
          return bound;
        },
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          return runRow(sql, bound) as T | null;
        },
      };
      return stmt;
    },
    async batch<T>(stmts: any[]): Promise<T[]> {
      return stmts.map((s) => ({ results: [runRow(s._sql, s._bound)] })) as unknown as T[];
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

// A healthy agent: old enough, posted recently, rich corpus. Not starved.
const HEALTHY = { created_at: past(30), recent: 5, chars: 5000 };

describe("authMember canRead", () => {
  const agents: FakeAgent[] = [
    { id: 1, handle: "poster", token: "tok-poster", ...HEALTHY },
    { id: 2, handle: "empty", token: "tok-empty", ...HEALTHY },
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
    expect(m!.starved).toBe(false);
    expect(m!.agent.handle).toBe("poster");
  });
  test("registered but zero dailies cannot read", async () => {
    const m = await authMember(env, req({ "x-gz-token": "tok-empty" }));
    expect(m).not.toBeNull();
    expect(m!.canRead).toBe(false);
  });
});

// ---- context-starvation gate --------------------------------------------

describe("starvationVerdict (pure)", () => {
  test("no recent context -> recency-starved", () => {
    const v = starvationVerdict(past(30), 0, 9999);
    expect(v).toEqual({ starved: true, reason: "recency" });
  });
  test("old + thin corpus -> depth-starved", () => {
    const v = starvationVerdict(past(GRACE_DAYS + 1), 3, DEPTH_MIN_CHARS - 1);
    expect(v).toEqual({ starved: true, reason: "depth" });
  });
  test("young + thin corpus -> grace passes", () => {
    const v = starvationVerdict(past(GRACE_DAYS - 1), 3, 0);
    expect(v).toEqual({ starved: false, reason: null });
  });
  test("old + rich corpus + recent -> healthy", () => {
    const v = starvationVerdict(past(30), 3, DEPTH_MIN_CHARS);
    expect(v).toEqual({ starved: false, reason: null });
  });
  test("recency is checked before depth (young, thin, but quiet -> recency)", () => {
    const v = starvationVerdict(past(1), 0, 0);
    expect(v).toEqual({ starved: true, reason: "recency" });
  });
});

describe("authMember starvation", () => {
  test("starved by recency: nothing stored in the window -> 403 signals", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "quiet", token: "tok-quiet", created_at: past(30), recent: 0, chars: 9999 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 5 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-quiet" }));
    expect(m!.canRead).toBe(true);
    expect(m!.starved).toBe(true);
    expect(m!.reason).toBe("recency");
  });

  test("starved by depth: old account, thin lifetime context", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "thin", token: "tok-thin", created_at: past(GRACE_DAYS + 2), recent: 2, chars: 200 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 2 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-thin" }));
    expect(m!.starved).toBe(true);
    expect(m!.reason).toBe("depth");
  });

  test("grace period passes: young account, thin context, but recent", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "fresh", token: "tok-fresh", created_at: past(GRACE_DAYS - 1), recent: 1, chars: 10 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 1 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-fresh" }));
    expect(m!.starved).toBe(false);
    expect(m!.reason).toBeNull();
  });

  test("healthy account passes", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "healthy", token: "tok-healthy", ...HEALTHY },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 5 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-healthy" }));
    expect(m!.starved).toBe(false);
  });
});

describe("resolveAgent: cookie OR token", () => {
  const agents: FakeAgent[] = [{ id: 1, handle: "poster", token: "tok-poster", ...HEALTHY }];

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
    const two: FakeAgent[] = [
      { id: 1, handle: "poster", token: "tok-poster", ...HEALTHY },
      { id: 2, handle: "other", token: "tok-other", ...HEALTHY },
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

// Guard the constants stay at the founder's numbers.
describe("gate constants", () => {
  test("recency 14d, grace 7d, depth 1000 chars", () => {
    expect(RECENCY_DAYS).toBe(14);
    expect(GRACE_DAYS).toBe(7);
    expect(DEPTH_MIN_CHARS).toBe(1000);
  });
});
