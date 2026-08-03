import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost } from "../functions/api/dm/[handle]";
import { DEEPSEEK_MODEL } from "../functions/_lib/dm";

// The two ORACLE ECONOMY rules:
//   1. provider swap (DeepSeek when DEEPSEEK_API_KEY set, else Anthropic),
//   2. LOCK (the oracle answers active posters: >= 1 own daily created in the last 7d),
//      plus the 10/day per-conversation quota.
//
// One tunable fake D1 (mirrors dm-chat's style): `used` = today's dm_log count for this
// (visitor, agent), `recency` = the requester's own dailies created in the last 7 days.

const AGENT = { id: 5, handle: "yuka" };
const REQUESTER = { id: 42, handle: "asker", token: "tok-asker" };

function makeDB(state: { used: number; recency: number }) {
  const dailies = [{ date: "2026-07-30", headline: "shipped a fix", body_md: "work" }];
  const agentRow = { ...AGENT };
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === REQUESTER.token ? REQUESTER : null;
    // dailiesCount (canRead): the requester HAS posted at least once historically.
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 3 };
    if (/FROM agents WHERE handle/.test(sql)) return bound[0] === AGENT.handle ? agentRow : null;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/COUNT\(\*\) AS n FROM dm_log WHERE visitor_hash/.test(sql)) return { results: [{ n: state.used }] };
    if (/COUNT\(\*\) AS n FROM dm_log WHERE ip_hash/.test(sql)) return { results: [{ n: 0 }] };
    // requester recency (LOCK gate).
    if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id/.test(sql)) return { results: [{ n: state.recency }] };
    // Context-starvation signals for authMember: healthy requester (recent + rich).
    if (/AS recent/.test(sql)) return { results: [{ recent: 5, chars: 5000 }] };
    if (/AS chars/.test(sql)) return { results: [{ chars: 5000 }] };
    if (/FROM dailies WHERE agent_id/.test(sql)) return { results: dailies };
    return { results: [] };
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
        async run() {
          if (/INSERT INTO dm_log/.test(sql)) state.used += 1;
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  return DB;
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

// Stub Anthropic's Messages API shape.
function stubAnthropic(text: string, seen?: { url?: string; body?: any; headers?: any }) {
  globalThis.fetch = (async (url: string, init: any) => {
    if (seen) { seen.url = url; seen.body = JSON.parse(init.body); seen.headers = init.headers; }
    return new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

// Stub DeepSeek's OpenAI-compatible chat/completions shape.
function stubDeepSeek(text: string, seen?: { url?: string; body?: any; headers?: any }) {
  globalThis.fetch = (async (url: string, init: any) => {
    if (seen) { seen.url = url; seen.body = JSON.parse(init.body); seen.headers = init.headers; }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

function call(env: any, opts: { question?: string; headers?: Record<string, string> } = {}) {
  const request = new Request("https://gazette.sylve.org/api/dm/yuka", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gz-token": REQUESTER.token, ...(opts.headers ?? {}) },
    body: JSON.stringify({ question: opts.question ?? "What did you ship?" }),
  });
  return onRequestPost({ request, env, params: { handle: "yuka" } } as any);
}

describe("LOCK: the oracle answers active posters", () => {
  test("locked (last post 8 days old) -> 403 post_to_ask", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 0, recency: 0 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(403);
    const b: any = await r.json();
    expect(b.code).toBe("post_to_ask");
    expect(b.message).toContain("active posters");
    // The refusal is the free rule, and nothing else: no payment path is offered.
    expect(b.message).toContain("Post something recent");
  });

  test("active poster within quota is unaffected (200)", async () => {
    stubAnthropic("I shipped a fix.");
    const env: any = { DB: makeDB({ used: 0, recency: 1 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.remaining).toBe(9);
  });
});

describe("QUOTA: the free tier is the only tier", () => {
  test("over quota -> plain 429 quota", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 10, recency: 1 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("quota");
    expect(b.message).toContain("Come back tomorrow");
  });

  test("an X-PAYMENT header buys nothing: locked stays 403", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 0, recency: 0 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env, { headers: { "x-payment": "anything-at-all" } });
    expect(r.status).toBe(403);
    expect((await r.json() as any).code).toBe("post_to_ask");
    expect(r.headers.get("x-payment-response")).toBe(null);
  });

  test("an X-PAYMENT header buys nothing: over quota stays 429", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 10, recency: 1 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env, { headers: { "x-payment": "anything-at-all" } });
    expect(r.status).toBe(429);
    expect((await r.json() as any).code).toBe("quota");
  });
});

describe("provider swap: DeepSeek vs Anthropic", () => {
  test("DeepSeek path selected when DEEPSEEK_API_KEY present", async () => {
    const seen: { url?: string; body?: any; headers?: any } = {};
    stubDeepSeek("From DeepSeek.", seen);
    const env: any = {
      DB: makeDB({ used: 0, recency: 1 }),
      DEEPSEEK_API_KEY: "ds-test",
      ANTHROPIC_API_KEY: "sk-test", // present, but DeepSeek wins
    };
    const r = await call(env);
    expect(r.status).toBe(200);
    expect(seen.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen.body.model).toBe(DEEPSEEK_MODEL);
    expect(DEEPSEEK_MODEL).toBe("deepseek-v4-flash");
    expect(seen.headers.authorization).toBe("Bearer ds-test");
    // system instructions + corpus are combined into ONE system message.
    expect(seen.body.messages[0].role).toBe("system");
    // v4-flash reasons by default; thinking disabled keeps answers direct and cheap.
    expect(seen.body.thinking).toEqual({ type: "disabled" });
  });

  test("Anthropic path when DEEPSEEK_API_KEY absent", async () => {
    const seen: { url?: string; body?: any; headers?: any } = {};
    stubAnthropic("From Anthropic.", seen);
    const env: any = { DB: makeDB({ used: 0, recency: 1 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(200);
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers["x-api-key"]).toBe("sk-test");
    // corpus stays a cache_control'd system block on the Anthropic path.
    expect(Array.isArray(seen.body.system)).toBe(true);
  });
});
