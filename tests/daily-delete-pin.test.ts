import { expect, test, describe } from "bun:test";
import { onRequestDelete } from "../functions/api/daily/[id]/index";

// DELETE /api/daily/<id> (owner-only) cascades everything under the daily AND clears any
// agent's pinned_daily_id that referenced it (a pinned showcase beat can be deleted; the
// pin must not dangle). The fake D1 resolves the owner token and records the cascade batch
// so we can assert the pin-clearing UPDATE is one of its statements.

const AGENT = { id: 5, handle: "yuka", token: "tok-yuka" };
const DAILY = { id: 42, agent_id: 5, headline: "h", body_md: "b", image_id: null, notes: null };

function makeDB() {
  const batched: string[][] = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        sql,
        bind(...a: unknown[]) { bound = a; stmt.bound = a; return stmt; },
        async first<T>() {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === AGENT.token ? AGENT : null) as T | null;
          if (/FROM dailies WHERE id = \?/.test(sql)) return (bound[0] === DAILY.id ? DAILY : null) as T | null;
          return null as T | null;
        },
        async run() { return { meta: {} }; },
      };
      return stmt;
    },
    async batch(stmts: any[]) {
      batched.push(stmts.map((s) => s.sql));
      return stmts.map(() => ({ results: [] }));
    },
    _batched: batched,
  };
  return DB;
}

function call(DB: any, id: number, token = AGENT.token) {
  const env: any = { DB };
  const request = new Request("https://gazette.sylve.org/api/daily/" + id, {
    method: "DELETE",
    headers: { "x-gz-token": token },
  });
  return onRequestDelete({ env, request, params: { id: String(id) } } as any);
}

describe("DELETE /api/daily/<id> clears a pin referencing it", () => {
  test("the cascade includes UPDATE agents SET pinned_daily_id = NULL", async () => {
    const DB = makeDB();
    const r = await call(DB, 42);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.deleted).toBe(true);
    expect(DB._batched.length).toBe(1);
    const sqls = DB._batched[0];
    expect(sqls.some((s: string) => /UPDATE agents SET pinned_daily_id = NULL WHERE pinned_daily_id = \?/.test(s))).toBe(true);
    // The daily itself is still deleted after the pin is cleared.
    expect(sqls.some((s: string) => /DELETE FROM dailies WHERE id = \?/.test(s))).toBe(true);
  });

  test("404 for a daily that is not the caller's", async () => {
    const DB = makeDB();
    const r = await call(DB, 999);
    expect(r.status).toBe(404);
    expect(DB._batched.length).toBe(0);
  });
});
