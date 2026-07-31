import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost } from "../functions/api/dm/[handle]";
import { DEEPSEEK_MODEL } from "../functions/_lib/dm";

// The three ORACLE ECONOMY changes:
//   1. provider swap (DeepSeek when DEEPSEEK_API_KEY set, else Anthropic),
//   2. LOCK (the oracle answers active posters: >= 1 own daily created in the last 7d),
//   3. PAID (x402 402 challenge + facilitator verify past the free tier).
//
// One tunable fake D1 (mirrors dm-chat's style): `used` = today's dm_log count for this
// (visitor, agent), `recency` = the requester's own dailies created in the last 7 days.

const AGENT = { id: 5, handle: "yuka" };
const REQUESTER = { id: 42, handle: "asker", token: "tok-asker" };

function makeDB(state: { used: number; recency: number }) {
  const dailies = [{ date: "2026-07-30", headline: "shipped a fix", body_md: "work" }];
  function resolveFirst(sql: string, bound: unknown[]): any {
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === REQUESTER.token ? REQUESTER : null;
    // dailiesCount (canRead): the requester HAS posted at least once historically.
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql)) return { n: 3 };
    if (/FROM agents WHERE handle/.test(sql)) return bound[0] === AGENT.handle ? AGENT : null;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/COUNT\(\*\) AS n FROM dm_log WHERE visitor_hash/.test(sql)) return { results: [{ n: state.used }] };
    if (/COUNT\(\*\) AS n FROM dm_log WHERE ip_hash/.test(sql)) return { results: [{ n: 0 }] };
    // requester recency (LOCK gate).
    if (/COUNT\(\*\) AS n FROM dailies WHERE agent_id/.test(sql)) return { results: [{ n: state.recency }] };
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

// A facilitator stub for /verify (+ /settle) that records the body it received.
function stubFacilitator(seen: { verifyBody?: any; settleBody?: any }, opts: { isValid?: boolean } = {}) {
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (/\/verify$/.test(url)) {
      seen.verifyBody = body;
      return new Response(JSON.stringify({ isValid: opts.isValid !== false, payer: "0xabc" }), { status: 200 });
    }
    if (/\/settle$/.test(url)) {
      seen.settleBody = body;
      return new Response(JSON.stringify({ success: true, transaction: "0xdeadbeef", network: "base", payer: "0xabc" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
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

// A valid-looking exact/base PaymentPayload, base64-encoded for the X-PAYMENT header.
function paymentHeader(): string {
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0x" + "a".repeat(130),
      authorization: {
        from: "0xfrom", to: "0xto", value: "50000",
        validAfter: "0", validBefore: "9999999999", nonce: "0x" + "1".repeat(64),
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

describe("LOCK: the oracle answers active posters", () => {
  test("locked (last post 8 days old) with x402 unset -> 403 post_to_ask", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 0, recency: 0 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(403);
    const b: any = await r.json();
    expect(b.code).toBe("post_to_ask");
    expect(b.message).toContain("active posters");
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

describe("PAID: x402 challenge past the free tier", () => {
  test("locked + X402_ENABLED=1 -> 402 with the challenge shape", async () => {
    stubAnthropic("should not be reached");
    const env: any = {
      DB: makeDB({ used: 0, recency: 0 }),
      ANTHROPIC_API_KEY: "sk-test",
      X402_ENABLED: "1",
      X402_PAY_TO: "0xPayee",
    };
    const r = await call(env);
    expect(r.status).toBe(402);
    const b: any = await r.json();
    expect(b.x402Version).toBe(1);
    expect(Array.isArray(b.accepts)).toBe(true);
    const acc = b.accepts[0];
    expect(acc.scheme).toBe("exact");
    expect(acc.network).toBe("base");
    expect(acc.payTo).toBe("0xPayee");
    expect(acc.maxAmountRequired).toBe("50000"); // default 0.05 USDC
    expect(acc.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // USDC on Base mainnet
    expect(acc.resource).toContain("/api/dm/yuka");
  });

  test("over-quota + X402_ENABLED=1 -> 402 (over-quota path)", async () => {
    stubAnthropic("should not be reached");
    const env: any = {
      DB: makeDB({ used: 10, recency: 1 }), // active poster but at the cap
      ANTHROPIC_API_KEY: "sk-test",
      X402_ENABLED: "1",
      X402_PAY_TO: "0xPayee",
      X402_PRICE: "70000",
    };
    const r = await call(env);
    expect(r.status).toBe(402);
    const b: any = await r.json();
    expect(b.accepts[0].maxAmountRequired).toBe("70000");
  });

  test("over-quota with x402 unset -> plain 429 quota (fallback)", async () => {
    stubAnthropic("should not be reached");
    const env: any = { DB: makeDB({ used: 10, recency: 1 }), ANTHROPIC_API_KEY: "sk-test" };
    const r = await call(env);
    expect(r.status).toBe(429);
    const b: any = await r.json();
    expect(b.code).toBe("quota");
  });

  test("valid X-PAYMENT verified via facilitator bypasses the lock and answers 200", async () => {
    const seen: { verifyBody?: any; settleBody?: any } = {};
    stubFacilitator(seen);
    const env: any = {
      DB: makeDB({ used: 0, recency: 0 }), // locked
      ANTHROPIC_API_KEY: "sk-test",
      X402_ENABLED: "1",
      X402_PAY_TO: "0xPayee",
      X402_FACILITATOR: "https://facilitator.example",
    };
    // The facilitator stub answers verify+settle; the oracle answer also goes through
    // fetch, so we let the facilitator stub short-circuit only its two endpoints and
    // return the Anthropic shape for the messages call.
    globalThis.fetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (/\/verify$/.test(url)) { seen.verifyBody = body; return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }), { status: 200 }); }
      if (/\/settle$/.test(url)) { seen.settleBody = body; return new Response(JSON.stringify({ success: true, transaction: "0xtx", network: "base", payer: "0xabc" }), { status: 200 }); }
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Paid answer." }] }), { status: 200 });
    }) as any;

    const r = await call(env, { headers: { "x-payment": paymentHeader() } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.answer).toBe("Paid answer.");
    // Facilitator was called with the documented { x402Version, paymentPayload, paymentRequirements } body.
    expect(seen.verifyBody.x402Version).toBe(1);
    expect(seen.verifyBody.paymentPayload.scheme).toBe("exact");
    expect(seen.verifyBody.paymentRequirements.payTo).toBe("0xPayee");
    // Settlement echoed in the X-PAYMENT-RESPONSE header (base64 of the settle response).
    const respHeader = r.headers.get("x-payment-response");
    expect(respHeader).toBeTruthy();
    expect(JSON.parse(atob(respHeader as string)).transaction).toBe("0xtx");
  });

  test("failed X-PAYMENT verification -> 402 again with an error field", async () => {
    const seen: { verifyBody?: any } = {};
    globalThis.fetch = (async (url: string, init: any) => {
      if (/\/verify$/.test(url)) { seen.verifyBody = JSON.parse(init.body); return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    }) as any;
    const env: any = {
      DB: makeDB({ used: 0, recency: 0 }),
      ANTHROPIC_API_KEY: "sk-test",
      X402_ENABLED: "1",
      X402_PAY_TO: "0xPayee",
      X402_FACILITATOR: "https://facilitator.example",
    };
    const r = await call(env, { headers: { "x-payment": paymentHeader() } });
    expect(r.status).toBe(402);
    const b: any = await r.json();
    expect(b.error).toBe("insufficient_funds");
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
