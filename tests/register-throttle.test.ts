import { expect, test, describe } from "bun:test";
import { onRequestPost } from "../functions/api/register";

// Per-IP registration throttle (functions/api/register.ts). Registration is open
// (an invite is optional), so this endpoint is the only one that mints an account
// with no credential: it is capped at 3 per rolling hour and 8 per rolling day per
// IP, counted in register_log. A valid unused invite code skips the check.
//
// The fake D1 below stores register_log rows in memory and answers the throttle's
// single conditional-aggregate read from them, so a test can register in a loop and
// watch the real windows close.

const HOUR = 3600000;

interface RegRow {
  ip_hash: string;
  handle: string;
  created_at: string;
}

interface State {
  regs: RegRow[];
  agents: string[]; // handles that exist
  invites: Record<string, { code: string; used_by: number | null }>;
  inserted: string[]; // handles actually created
}

function makeDB(state: State) {
  let nextId = 100;
  function first(sql: string, bound: any[]): any {
    if (/FROM agents WHERE handle/.test(sql)) {
      return state.agents.includes(bound[0]) ? { id: 1, handle: bound[0] } : null;
    }
    if (/FROM invites WHERE code/.test(sql)) {
      return state.invites[bound[0]] ?? null;
    }
    if (/FROM register_log WHERE ip_hash/.test(sql)) {
      // bound = [hourAgo, ip_hash, dayAgo]
      const [hourAgo, ipHash, dayAgo] = bound as [string, string, string];
      const inDay = state.regs.filter((r) => r.ip_hash === ipHash && r.created_at >= dayAgo);
      return {
        h: inDay.filter((r) => r.created_at >= hourAgo).length,
        d: inDay.length,
      };
    }
    return null;
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: any[] = [];
      const stmt: any = {
        bind(...a: any[]) { bound = a; return stmt; },
        async first<T>() { return first(sql, bound) as T | null; },
        async all<T>() { return { results: [] as T[] }; },
        async run() {
          if (/INSERT INTO agents/.test(sql)) {
            state.agents.push(bound[0]);
            state.inserted.push(bound[0]);
            return { meta: { last_row_id: nextId++, changes: 1 } };
          }
          if (/INSERT INTO register_log/.test(sql)) {
            state.regs.push({ ip_hash: bound[0], handle: bound[1], created_at: bound[2] });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE invites/.test(sql)) {
            const row = state.invites[bound[2]];
            if (row) row.used_by = bound[0];
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map(() => ({ results: [] })); },
  };
  return DB;
}

function newState(over: Partial<State> = {}): State {
  return { regs: [], agents: [], invites: {}, inserted: [], ...over };
}

function post(body: any, headers: Record<string, string> = {}) {
  return new Request("https://gazette.sylve.org/api/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function register(state: State, handle: string, headers: Record<string, string>, invite?: string) {
  const env: any = { DB: makeDB(state) };
  const req = post(invite ? { handle, invite } : { handle }, headers);
  return (onRequestPost as any)({ request: req, env, params: {} });
}

const IP = { "CF-Connecting-IP": "203.0.113.7" };

describe("register: per-IP throttle", () => {
  test("allows the first 3 in an hour, refuses the 4th with 429 and creates nothing", async () => {
    const state = newState();
    for (let i = 0; i < 3; i++) {
      const res = await register(state, "agent-" + i, IP);
      expect(res.status).toBe(200);
    }
    expect(state.inserted).toEqual(["agent-0", "agent-1", "agent-2"]);

    const res = await register(state, "agent-3", IP);
    expect(res.status).toBe(429);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("rate_limited");
    expect(typeof body.message).toBe("string");
    // No account minted, and the refusal itself is not counted.
    expect(state.inserted).toEqual(["agent-0", "agent-1", "agent-2"]);
    expect(state.regs.length).toBe(3);
  });

  test("the hourly window rolls: rows older than an hour stop counting", async () => {
    const state = newState();
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    state.regs.push({ ip_hash: "x", handle: "a", created_at: old });
    // Fill the hour with 3 rows for THIS ip by registering 3 times.
    for (let i = 0; i < 3; i++) await register(state, "agent-" + i, IP);
    expect((await register(state, "agent-x", IP)).status).toBe(429);
    // Age those three out of the hour (but keep them inside the day).
    const ninetyMin = new Date(Date.now() - 1.5 * HOUR).toISOString();
    for (const r of state.regs) r.created_at = ninetyMin;
    const res = await register(state, "agent-later", IP);
    expect(res.status).toBe(200);
    expect(state.inserted).toContain("agent-later");
  });

  test("the daily cap holds even when the hour is clear", async () => {
    const state = newState();
    const ipHashSeed: string[] = [];
    // 8 registrations spread over the day, all outside the last hour.
    for (let i = 0; i < 3; i++) await register(state, "agent-" + i, IP);
    const ipHash = state.regs[0].ip_hash;
    ipHashSeed.push(ipHash);
    for (let i = 0; i < 5; i++) {
      state.regs.push({ ip_hash: ipHash, handle: "seed-" + i, created_at: new Date(Date.now() - 5 * HOUR).toISOString() });
    }
    for (const r of state.regs) r.created_at = new Date(Date.now() - 5 * HOUR).toISOString();
    expect(state.regs.length).toBe(8);
    const res = await register(state, "agent-9", IP);
    expect(res.status).toBe(429);
    expect((await res.json() as any).code).toBe("rate_limited");
  });

  test("a valid unused invite code bypasses the throttle", async () => {
    const state = newState({ invites: { goodcode: { code: "goodcode", used_by: null } } });
    for (let i = 0; i < 3; i++) await register(state, "agent-" + i, IP);
    expect((await register(state, "blocked", IP)).status).toBe(429);

    const res = await register(state, "invited", IP, "goodcode");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.handle).toBe("invited");
    expect(body.invites.length).toBe(3);
    expect(state.inserted).toContain("invited");
    // The invited registration is still recorded, so it counts for the NEXT caller.
    expect(state.regs.length).toBe(4);
  });

  test("an already-used invite code does not bypass the throttle", async () => {
    const state = newState({ invites: { burned: { code: "burned", used_by: 42 } } });
    for (let i = 0; i < 3; i++) await register(state, "agent-" + i, IP);
    const res = await register(state, "sneaky", IP, "burned");
    expect(res.status).toBe(429);
    expect(state.inserted).not.toContain("sneaky");
  });

  test("two different IPs have independent buckets", async () => {
    const state = newState();
    for (let i = 0; i < 3; i++) await register(state, "a-" + i, IP);
    expect((await register(state, "a-3", IP)).status).toBe(429);
    const other = { "CF-Connecting-IP": "198.51.100.9" };
    expect((await register(state, "b-0", other)).status).toBe(200);
  });

  test("a missing CF-Connecting-IP header shares ONE bucket and is still throttled", async () => {
    const state = newState();
    for (let i = 0; i < 3; i++) {
      expect((await register(state, "noip-" + i, {})).status).toBe(200);
    }
    const res = await register(state, "noip-3", {});
    expect(res.status).toBe(429);
    // All four requests hashed to the same bucket (the 0.0.0.0 fallback).
    const hashes = new Set(state.regs.map((r) => r.ip_hash));
    expect(hashes.size).toBe(1);
    // And that bucket is NOT the bucket of a request that did carry an IP.
    const withIp = newState();
    await register(withIp, "with-ip", IP);
    expect(withIp.regs[0].ip_hash).not.toBe(state.regs[0].ip_hash);
  });

  test("a taken handle 409s without burning throttle quota", async () => {
    const state = newState({ agents: ["taken"] });
    const res = await register(state, "taken", IP);
    expect(res.status).toBe(409);
    expect(state.regs.length).toBe(0);
  });

  test("fails OPEN when the counter table is unavailable", async () => {
    const state = newState();
    const db = makeDB(state);
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/register_log/.test(sql)) {
        const stmt: any = {
          bind() { return stmt; },
          async first() { throw new Error("no such table: register_log"); },
          async run() { throw new Error("no such table: register_log"); },
        };
        return stmt;
      }
      return realPrepare(sql);
    };
    const res = await (onRequestPost as any)({ request: post({ handle: "openfail" }, IP), env: { DB: db }, params: {} });
    expect(res.status).toBe(200);
    expect(state.inserted).toContain("openfail");
  });
});
