import { expect, test, describe, afterEach } from "bun:test";
import { onRequestPost } from "../functions/api/dm/[handle]/[project]";

// The project-scoped ask endpoint mirrors the agent ask, but with two key
// differences we assert here:
//   1. the corpus query is filtered by BOTH agent_id AND project_id (this project's
//      dailies only), passed through buildCorpus;
//   2. the quota identity (dm_log visitor_hash) is scoped per project:
//      "member:" + requesterId + ":p" + projectId  (not the global "member:" + id).
// askOracle is exercised for real; we stub global fetch so it never hits the live API.

const AGENT = { id: 5, handle: "yuka" };
const PROJECT = { id: 3, name: "Yuka", slug: "yuka", descriptor: "price tracker" };
const REQUESTER = { id: 42, handle: "asker", token: "tok-asker" };

// A fake D1 that answers each query the endpoint issues and records what it saw.
function makeDB(capture: {
  corpusSql?: string;
  corpusBinds?: unknown[];
  insertBinds?: unknown[];
  priorBinds?: unknown[];
}) {
  const dailies = [
    { date: "2026-07-30", headline: "shipped a fix to Yuka", body_md: "scoped work" },
  ];
  function resolveFirst(sql: string, bound: unknown[]): any {
    // authMember -> resolveAgent -> getAgentByToken
    if (/FROM agents WHERE token/.test(sql)) return bound[0] === REQUESTER.token ? REQUESTER : null;
    // dailiesCount for canRead
    if (/COUNT\(\*\).*FROM dailies WHERE agent_id/.test(sql) && !/project_id/.test(sql))
      return { n: 1 };
    // getAgentByHandle
    if (/FROM agents WHERE handle/.test(sql)) return bound[0] === AGENT.handle ? AGENT : null;
    // project resolution by (agent_id, slug)
    if (/FROM projects WHERE agent_id = \? AND slug/.test(sql))
      return bound[1] === PROJECT.slug ? PROJECT : null;
    // quota: prior question this (visitor, agent, day)
    if (/FROM dm_log WHERE visitor_hash/.test(sql)) {
      capture.priorBinds = bound;
      return null; // no prior
    }
    // IP backstop count
    if (/COUNT\(\*\) AS n FROM dm_log WHERE ip_hash/.test(sql)) return { n: 0 };
    return null;
  }
  const DB: any = {
    withSession() { return DB; },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() { return resolveFirst(sql, bound) as T | null; },
        async all<T>() {
          if (/FROM dailies WHERE agent_id = \? AND project_id/.test(sql)) {
            capture.corpusSql = sql;
            capture.corpusBinds = bound;
            return { results: dailies } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          if (/INSERT INTO dm_log/.test(sql)) capture.insertBinds = bound;
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return DB;
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function stubAnthropic(answerText: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: answerText }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any;
}

async function callEndpoint(capture: any, question = "What did you ship?") {
  const env: any = { DB: makeDB(capture), ANTHROPIC_API_KEY: "sk-test" };
  const request = new Request("https://gazette.sylve.org/api/dm/yuka/yuka", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gz-token": REQUESTER.token },
    body: JSON.stringify({ question }),
  });
  return onRequestPost({ request, env, params: { handle: "yuka", project: "yuka" } } as any);
}

describe("project-scoped DM endpoint", () => {
  test("builds a project-filtered corpus (agent_id AND project_id)", async () => {
    stubAnthropic("I shipped a fix to Yuka and cleaned up the tracker.");
    const capture: any = {};
    const r = await callEndpoint(capture);
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.answer).toBeTruthy();
    // First message of the day: 10 cap minus this one leaves 9.
    expect(body.remaining).toBe(9);
    // The corpus query filters on both the agent and the project.
    expect(capture.corpusSql).toMatch(/agent_id = \? AND project_id/);
    expect(capture.corpusBinds).toEqual([AGENT.id, PROJECT.id]);
  });

  test("uses the per-project scoped quota key (member:<id>:p<projectId>)", async () => {
    stubAnthropic("I shipped a fix.");
    const capture: any = {};
    await callEndpoint(capture);
    const scopedHash = "member:" + REQUESTER.id + ":p" + PROJECT.id;
    // Quota lookup used the scoped hash...
    expect(capture.priorBinds?.[0]).toBe(scopedHash);
    // ...and the dm_log insert logged it under that same scoped hash, agent_id = agent.id.
    expect(capture.insertBinds?.[0]).toBe(AGENT.id); // agent_id
    expect(capture.insertBinds?.[1]).toBe(scopedHash); // visitor_hash
  });

  test("cleanAnswer runs: no em/en dash in the returned answer", async () => {
    stubAnthropic("I shipped it — then I tested it.");
    const capture: any = {};
    const r = await callEndpoint(capture);
    const body: any = await r.json();
    expect(body.answer).not.toMatch(/[—–]/);
    expect(body.answer).toContain("I shipped it, then I tested it.");
  });

  test("404 for an unknown project slug", async () => {
    stubAnthropic("unused");
    const capture: any = {};
    const env: any = { DB: makeDB(capture), ANTHROPIC_API_KEY: "sk-test" };
    const request = new Request("https://gazette.sylve.org/api/dm/yuka/nope", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gz-token": REQUESTER.token },
      body: JSON.stringify({ question: "hi" }),
    });
    const r = await onRequestPost({ request, env, params: { handle: "yuka", project: "nope" } } as any);
    expect(r.status).toBe(404);
  });
});
