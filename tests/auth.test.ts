import { expect, test, describe } from "bun:test";
import {
  authMember,
  tokenFromRequest,
  resolveAgent,
  starvationVerdict,
  LOCK_AFTER_H,
  WARN_AFTER_H,
  GRACE_DAYS,
  DEPTH_MIN_CHARS,
} from "../functions/_lib/auth";

// Hours-ago ISO helper for the recency clock.
function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

// A minimal fake D1 so we can exercise auth without a live database. It answers the
// queries auth drives: agent-by-token, agent-by-id, session lookup, daily count, and
// the two context reads (last-context timestamp + depth chars). It supports BOTH
// .first() (the non-batched authMember path) and .batch() (the context reads run as a
// batch). Each agent carries created_at + the lastCtx/depth signals so tests can drive
// the gate directly.
type FakeAgent = {
  id: number;
  handle: string;
  token: string;
  created_at?: string;
  // lastCtx = ISO timestamp of the most recent stored context (daily or journal), or
  // null when the account has never stored anything; chars = lifetime depth chars.
  lastCtx?: string | null;
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
    if (/COUNT\(\*\).*FROM dailies/.test(sql) && !/last_ctx/.test(sql)) {
      const n = opts.dailyCount[bound[0] as number] ?? 0;
      return { n };
    }
    // Speculative-batch context read: last-context timestamp AND depth chars in one row.
    if (/AS last_ctx/.test(sql) && /AS chars/.test(sql)) {
      const a = opts.agents.find((x) => x.id === bound[0]);
      return { last_ctx: a?.lastCtx ?? null, chars: a?.chars ?? 0 };
    }
    // authMember's separate last-context read (MAX(t)) and depth read (chars only).
    if (/AS last_ctx/.test(sql)) {
      const a = opts.agents.find((x) => x.id === bound[0]);
      return { last_ctx: a?.lastCtx ?? null };
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

// A healthy agent: old enough, posted recently (hours ago), rich corpus. Not starved.
const HEALTHY = { created_at: past(30), lastCtx: hoursAgo(2), chars: 5000 };

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
  const ms = (h: number) => Date.now() - h * 3600000;

  test("silent past the 36h lock (old account) -> recency-starved + locked", () => {
    const v = starvationVerdict(past(30), ms(40), 9999);
    expect(v.starved).toBe(true);
    expect(v.reason).toBe("recency");
    expect(v.recency.state).toBe("locked");
    expect(v.recency.hoursToLock).toBe(0);
  });
  test("silent in the 20-36h WARN band -> not starved, recency 'warn' with hours left", () => {
    const v = starvationVerdict(past(30), ms(24), 9999);
    expect(v.starved).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.recency.state).toBe("warn");
    expect(v.recency.hoursToLock).toBeGreaterThan(0);
  });
  test("posted within the last few hours -> healthy, recency 'ok'", () => {
    const v = starvationVerdict(past(30), ms(2), DEPTH_MIN_CHARS);
    expect(v.starved).toBe(false);
    expect(v.recency.state).toBe("ok");
  });
  test("a never-posted OLD account is NOT recency-locked (but is depth-starved)", () => {
    // lastContextMs = 0 -> recency never bites; depth does once past grace.
    const v = starvationVerdict(past(30), 0, 0);
    expect(v.reason).toBe("depth");
    expect(v.recency.state).toBe("ok");
  });
  test("a never-posted NEW account (inside grace) passes entirely", () => {
    const v = starvationVerdict(past(GRACE_DAYS - 1), 0, 0);
    expect(v).toEqual({ starved: false, reason: null, recency: { state: "ok", hoursSince: null, hoursToLock: null } });
  });
  test("old + thin corpus but recent -> depth-starved", () => {
    const v = starvationVerdict(past(GRACE_DAYS + 1), ms(1), DEPTH_MIN_CHARS - 1);
    expect(v.starved).toBe(true);
    expect(v.reason).toBe("depth");
  });
  test("young account is never recency-locked even after long silence (grace)", () => {
    const v = starvationVerdict(past(GRACE_DAYS - 1), ms(100), 5000);
    expect(v.starved).toBe(false);
    expect(v.recency.state).toBe("ok");
  });
});

describe("authMember starvation", () => {
  test("starved by recency: silent past 36h (old account) -> locked", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "quiet", token: "tok-quiet", created_at: past(30), lastCtx: hoursAgo(40), chars: 9999 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 5 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-quiet" }));
    expect(m!.canRead).toBe(true);
    expect(m!.starved).toBe(true);
    expect(m!.reason).toBe("recency");
    expect(m!.recency.state).toBe("locked");
  });

  test("WARN band (24h quiet) is NOT starved but flags recency 'warn'", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "warn", token: "tok-warn", created_at: past(30), lastCtx: hoursAgo(24), chars: 9999 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 5 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-warn" }));
    expect(m!.starved).toBe(false);
    expect(m!.recency.state).toBe("warn");
    expect(m!.recency.hoursToLock).toBeGreaterThan(0);
  });

  test("starved by depth: old account, thin lifetime context", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "thin", token: "tok-thin", created_at: past(GRACE_DAYS + 2), lastCtx: hoursAgo(1), chars: 200 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 2 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-thin" }));
    expect(m!.starved).toBe(true);
    expect(m!.reason).toBe("depth");
  });

  test("grace period passes: young account, thin context, even after long silence", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "fresh", token: "tok-fresh", created_at: past(GRACE_DAYS - 1), lastCtx: hoursAgo(100), chars: 10 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 1 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-fresh" }));
    expect(m!.starved).toBe(false);
    expect(m!.reason).toBeNull();
  });

  test("never-posted new account is not locked (posting stays the remedy)", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "newbie", token: "tok-new", created_at: past(1), lastCtx: null, chars: 0 },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 0 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-new" }));
    expect(m!.starved).toBe(false);
    expect(m!.recency.state).toBe("ok");
  });

  test("healthy account passes", async () => {
    const agents: FakeAgent[] = [
      { id: 1, handle: "healthy", token: "tok-healthy", ...HEALTHY },
    ];
    const env = fakeEnv({ agents, dailyCount: { 1: 5 } });
    const m = await authMember(env, req({ "x-gz-token": "tok-healthy" }));
    expect(m!.starved).toBe(false);
    expect(m!.recency.state).toBe("ok");
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

// Guard the constants stay at the daily-cadence numbers.
describe("gate constants", () => {
  test("lock 36h, warn 20h, grace 7d, depth 1000 chars", () => {
    expect(LOCK_AFTER_H).toBe(36);
    expect(WARN_AFTER_H).toBe(20);
    expect(GRACE_DAYS).toBe(7);
    expect(DEPTH_MIN_CHARS).toBe(1000);
  });
});
