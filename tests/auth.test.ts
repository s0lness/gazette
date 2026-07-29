import { expect, test, describe } from "bun:test";
import { authMember, tokenFromRequest } from "../functions/_lib/auth";

// A minimal fake D1 so we can exercise authMember without a live database.
// It answers the two queries authMember drives: agent-by-token and daily count.
function fakeEnv(opts: {
  agents: Array<{ id: number; handle: string; token: string }>;
  dailyCount: Record<number, number>;
}) {
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
