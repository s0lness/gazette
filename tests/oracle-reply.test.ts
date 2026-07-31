import { expect, test, describe, afterEach } from "bun:test";
import { maybeOracleReply, catchUpOracleReply, ORACLE_DAILY_CAP } from "../functions/_lib/oracle-reply";

// The oracle-reply core answers a PUBLIC comment under an agent's post AS the agent,
// from its corpus, while the agent is away. An oracle reply is a comments row authored
// by the DAILY AUTHOR's agent, kind = "oracle", reply_to = the answered comment id.
//
// The fake D1 lets each test declare: the daily (author + optional project), the target
// comment, whether an oracle reply already answers it, whether the author replied after,
// and the author's oracle count today. It records the INSERT so we can assert the row
// shape (author id, kind, reply_to). askOracleReply is exercised for real against a
// stubbed global fetch.

const AUTHOR = { id: 5, handle: "yuka", token: "tok-yuka", repo_url: null, url: null };
const COMMENTER = { id: 42, handle: "asker" };

interface Opts {
  comment?: any; // the target comment row (with handle)
  daily?: any; // the daily row
  alreadyAnswered?: number; // count of existing oracle replies for reply_to = comment.id
  authorAfter?: number; // count of author non-oracle comments after the comment
  oracleToday?: number; // author's oracle replies created today
  hasKey?: boolean;
  project?: { id: number; name: string; descriptor: string | null };
  catchUpCandidate?: any; // the row returned by the catch-up oldest-unanswered query
}

function makeEnv(opts: Opts) {
  const inserted: unknown[][] = [];
  const daily =
    opts.daily ??
    { id: 100, agent_id: AUTHOR.id, headline: "shipped a fix", body_md: "work in src/x.ts", project_id: opts.project ? opts.project.id : null };
  const comment =
    opts.comment ??
    { id: 7, daily_id: 100, agent_id: COMMENTER.id, body: "how did you test it?", created_at: "2026-07-30T10:00:00.000Z", kind: null, reply_to: null, handle: COMMENTER.handle };

  function resolveFirst(sql: string, bound: unknown[]): any {
    // loadComment (join agents)
    if (/FROM comments c JOIN agents a ON a\.id = c\.agent_id WHERE c\.id/.test(sql)) return comment;
    // loadDaily
    if (/FROM dailies WHERE id/.test(sql)) return daily;
    // loadAgentById
    if (/FROM agents WHERE id/.test(sql)) return bound[0] === AUTHOR.id ? AUTHOR : null;
    // project lookup
    if (/FROM projects WHERE id/.test(sql)) return opts.project ?? null;
    // catch-up oldest-unanswered candidate
    if (/NOT EXISTS \(SELECT 1 FROM comments r WHERE r\.reply_to/.test(sql)) return opts.catchUpCandidate ?? null;
    return null;
  }
  function resolveAll(sql: string): { results: any[] } {
    // corpus read (returns dailies with notes)
    if (/SELECT date, headline, body_md, notes FROM dailies/.test(sql)) {
      return { results: [{ date: "2026-07-30", headline: "shipped a fix", body_md: "work", notes: "tested it twice on real hardware" }] };
    }
    return { results: [] };
  }
  // The three-bail batch (already-answered, author-after, cap).
  function resolveBatch(stmts: any[]): { results: any[] }[] {
    return stmts.map((s) => {
      const sql = s._sql as string;
      if (/reply_to = \? AND kind = 'oracle'/.test(sql)) return { results: [{ n: opts.alreadyAnswered ?? 0 }] };
      if (/kind IS NULL OR kind != 'oracle'.*created_at >/.test(sql) || /AND created_at > \?/.test(sql))
        return { results: [{ n: opts.authorAfter ?? 0 }] };
      if (/kind = 'oracle' AND created_at >=/.test(sql)) return { results: [{ n: opts.oracleToday ?? 0 }] };
      return { results: [] };
    });
  }
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        _sql: sql,
        bind(...a: unknown[]) { bound = a; stmt._bound = bound; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() { return resolveAll(sql) as { results: T[] }; },
        async run() {
          if (/INSERT INTO comments/.test(sql)) inserted.push(bound);
          return { meta: { last_row_id: 999 } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { return resolveBatch(stmts); },
  };
  const env: any = { DB, ANTHROPIC_API_KEY: opts.hasKey === false ? undefined : "sk-test" };
  return { env, inserted, daily, comment };
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

describe("oracle reply: happy path", () => {
  test("inserts an oracle reply authored by the daily author, with kind + reply_to", async () => {
    stubAnthropic("I tested it twice on real hardware before shipping.");
    const { env, inserted } = makeEnv({});
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(true);
    expect(inserted.length).toBe(1);
    const [dailyId, agentId, bodyText, , replyTo] = inserted[0] as any[];
    expect(dailyId).toBe(100);
    expect(agentId).toBe(AUTHOR.id); // authored by the daily AUTHOR
    expect(bodyText).toContain("tested it twice");
    expect(replyTo).toBe(7); // reply_to = the answered comment id
  });

  test("the returned answer has no em/en dash (cleanAnswer runs)", async () => {
    stubAnthropic("I shipped it — then I tested it.");
    const { env, inserted } = makeEnv({});
    await maybeOracleReply(env, 100, 7);
    expect(String((inserted[0] as any[])[2])).not.toMatch(/[—–]/);
  });
});

describe("oracle reply: bails", () => {
  test("self-comment: commenter IS the daily author", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({
      comment: { id: 7, daily_id: 100, agent_id: AUTHOR.id, body: "note to self", created_at: "2026-07-30T10:00:00.000Z", kind: null, reply_to: null, handle: AUTHOR.handle },
    });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the incoming comment is itself an oracle reply", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({
      comment: { id: 7, daily_id: 100, agent_id: AUTHOR.id, body: "generated", created_at: "2026-07-30T10:00:00.000Z", kind: "oracle", reply_to: 3, handle: AUTHOR.handle },
    });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("an oracle reply already answers this comment", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ alreadyAnswered: 1 });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the live author posted a non-oracle comment after the incoming one", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ authorAfter: 1 });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the author already hit the daily oracle cap (20)", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ oracleToday: ORACLE_DAILY_CAP });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("no ANTHROPIC_API_KEY", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ hasKey: false });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });

  test("the API call fails (503): nothing inserted", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
    const { env, inserted } = makeEnv({});
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });
});

describe("oracle reply: project scoping", () => {
  test("a projected daily scopes the corpus to that project", async () => {
    stubAnthropic("I built the tracker in src/track.ts.");
    const project = { id: 3, name: "Yuka", descriptor: "price tracker" };
    const { env, inserted } = makeEnv({
      project,
      daily: { id: 100, agent_id: AUTHOR.id, headline: "shipped", body_md: "work", project_id: 3 },
    });
    const ok = await maybeOracleReply(env, 100, 7);
    expect(ok).toBe(true);
    expect(inserted.length).toBe(1);
  });
});

describe("oracle reply: lazy catch-up", () => {
  test("answers the oldest unanswered non-author comment", async () => {
    stubAnthropic("I have not written about that here yet.");
    const cand = { id: 12, daily_id: 100, agent_id: COMMENTER.id, body: "does it handle offline?", created_at: "2026-07-29T09:00:00.000Z", kind: null, reply_to: null, handle: COMMENTER.handle };
    const { env, inserted } = makeEnv({ catchUpCandidate: cand });
    const ok = await catchUpOracleReply(env, 100);
    expect(ok).toBe(true);
    expect(inserted.length).toBe(1);
    expect((inserted[0] as any[])[4]).toBe(12); // reply_to = the caught-up comment
  });

  test("no unanswered comment: nothing inserted", async () => {
    stubAnthropic("unused");
    const { env, inserted } = makeEnv({ catchUpCandidate: null });
    const ok = await catchUpOracleReply(env, 100);
    expect(ok).toBe(false);
    expect(inserted.length).toBe(0);
  });
});
