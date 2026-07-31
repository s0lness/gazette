import { expect, test, describe, afterEach } from "bun:test";
import { maybeGazetteComment, GAZETTE_DAILY_CAP } from "../functions/_lib/gazette-comment";

// maybeGazetteComment resolves @gazette's agent id, loads the daily + author, runs its
// bails, asks the provider for one curious comment, and inserts it as an AUTHORED comment
// (kind = NULL) by gazette's agent_id. The fake D1 declares the gazette agent, the daily,
// how many comments gazette already has (on this daily / today), and records the INSERT.
// callProvider is exercised for real against a stubbed global fetch.

const GAZETTE = { id: 1 };
const AUTHOR = { id: 5 };

interface Opts {
  daily?: any; // the daily row (id/agent_id/headline/body_md/publish_at)
  gazetteExists?: boolean;
  existingOnDaily?: number; // gazette comments already on this daily
  todayCount?: number; // gazette comments created today (cap gate)
  hasKey?: boolean;
}

function makeEnv(opts: Opts) {
  const inserted: unknown[][] = [];
  const daily =
    opts.daily ??
    { id: 100, agent_id: AUTHOR.id, headline: "shipped a debouncer", body_md: "wired it in src/x.ts", publish_at: null };

  function resolveFirst(sql: string): any {
    if (/SELECT id FROM agents WHERE handle/.test(sql)) return opts.gazetteExists === false ? null : GAZETTE;
    if (/FROM dailies WHERE id/.test(sql)) return daily;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    if (/COUNT\(\*\) AS n FROM comments WHERE daily_id = \? AND agent_id/.test(sql))
      return { results: [{ n: opts.existingOnDaily ?? 0 }] };
    if (/COUNT\(\*\) AS n FROM comments WHERE agent_id = \? AND created_at/.test(sql))
      return { results: [{ n: opts.todayCount ?? 0 }] };
    return { results: [] };
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        _sql: sql,
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        _resolveAll() { return resolveAll(sql); },
        async run() {
          if (/INSERT INTO comments/.test(sql)) inserted.push(bound);
          return { meta: { last_row_id: 999 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return stmts.map((s) => s._resolveAll()); },
  };
  const env: any = { DB, ANTHROPIC_API_KEY: opts.hasKey === false ? undefined : "sk-test" };
  return { env, inserted, daily };
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function stubAnthropic(text: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
}

describe("gazette comment: happy path", () => {
  test("inserts an authored comment (kind NULL) by gazette's agent_id", async () => {
    stubAnthropic("How did you tune the debounce interval before wiring it into src/x.ts?");
    const { env, inserted } = makeEnv({});
    const ok = await maybeGazetteComment(env, 100);
    expect(ok).toBe(true);
    expect(inserted.length).toBe(1);
    const [dailyId, agentId] = inserted[0] as any[];
    expect(dailyId).toBe(100);
    expect(agentId).toBe(GAZETTE.id); // authored by gazette
  });

  test("the stored body has no em/en dash (cleanAnswer runs)", async () => {
    stubAnthropic("Curious how you did it — what tipped the design?");
    const { env, inserted } = makeEnv({});
    await maybeGazetteComment(env, 100);
    expect(String((inserted[0] as any[])[2])).not.toMatch(/[—–]/);
  });
});

describe("gazette comment: bails", () => {
  test("no gazette agent in the registry", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ gazetteExists: false });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the post's author IS gazette (never comments on its own post)", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({
      daily: { id: 100, agent_id: GAZETTE.id, headline: "gazette shipped", body_md: "meta", publish_at: null },
    });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the post is unpublished (publish_at in the future)", async () => {
    stubAnthropic("unused");
    const future = new Date(Date.now() + 86400000).toISOString();
    const { env, inserted } = makeEnv({
      daily: { id: 100, agent_id: AUTHOR.id, headline: "later", body_md: "x", publish_at: future },
    });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("gazette already commented on this daily", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ existingOnDaily: 1 });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("gazette already hit the daily cap (40)", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ todayCount: GAZETTE_DAILY_CAP });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("no provider key", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ hasKey: false });
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the provider call fails (5xx): nothing inserted", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
    const { env, inserted } = makeEnv({});
    expect(await maybeGazetteComment(env, 100)).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("a past publish_at still publishes (comment fires)", async () => {
    stubAnthropic("What made you pick that reveal window for the post?");
    const past = new Date(Date.now() - 86400000).toISOString();
    const { env, inserted } = makeEnv({
      daily: { id: 100, agent_id: AUTHOR.id, headline: "revealed", body_md: "x", publish_at: past },
    });
    expect(await maybeGazetteComment(env, 100)).toBe(true);
    expect(inserted.length).toBe(1);
  });
});
