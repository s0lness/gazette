import { expect, test, describe } from "bun:test";
import { onRequestPost } from "../functions/api/[token]/profile";

// POST /api/<token>/profile sets the agent's durable links (repo_url, url) and bio.
// Each field: absent -> untouched; "" -> cleared (null); a value -> validated + set.
// repo_url/url must be http(s) URLs (422 otherwise); bio is privacy-linted and capped.
// The fake D1 resolves the token to an agent and records the UPDATE it runs.

const AGENT = { id: 5, handle: "yuka", token: "tok-yuka", display_name: "Yuka", bio: "old bio", repo_url: null, url: null, pinned_daily_id: null, scheduler_confirmed_at: null };

// ownedDailyIds: the daily ids the agent owns, so the pin ownership check can pass/fail.
function makeDB(ownedDailyIds: number[] = []) {
  const updates: { sql: string; binds: unknown[] }[] = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === AGENT.token ? AGENT : null) as T | null;
          // Pin ownership: SELECT id FROM dailies WHERE id = ? AND agent_id = ?
          if (/FROM dailies WHERE id = \? AND agent_id = \?/.test(sql)) {
            const [id, agentId] = bound as [number, number];
            return (agentId === AGENT.id && ownedDailyIds.includes(id) ? { id } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (/UPDATE agents SET/.test(sql)) updates.push({ sql, binds: bound });
          return { meta: {} };
        },
      };
      return stmt;
    },
    _updates: updates,
  };
  return DB;
}

function call(DB: any, body: any, token = AGENT.token) {
  const env: any = { DB };
  const request = new Request("https://gazette.sylve.org/api/" + token + "/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return onRequestPost({ env, request, params: { token } } as any);
}

describe("profile links endpoint", () => {
  test("sets repo_url + url + bio", async () => {
    const DB = makeDB();
    const r = await call(DB, {
      repo_url: "https://github.com/s0lness/gazette",
      url: "https://gazette.sylve.org",
      bio: "a registry of agent proof-of-work",
    });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.repo_url).toBe("https://github.com/s0lness/gazette");
    expect(b.url).toBe("https://gazette.sylve.org");
    expect(b.bio).toBe("a registry of agent proof-of-work");
    expect(DB._updates.length).toBe(1);
    expect(DB._updates[0].sql).toMatch(/repo_url = \?/);
    expect(DB._updates[0].sql).toMatch(/url = \?/);
    expect(DB._updates[0].sql).toMatch(/bio = \?/);
  });

  test("empty string clears a field (null)", async () => {
    const DB = makeDB();
    const r = await call(DB, { repo_url: "" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.repo_url).toBe(null);
    expect(DB._updates[0].binds[0]).toBe(null); // cleared to null
  });

  test("absent field is left untouched (no SET for it)", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "https://x.dev" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.url).toBe("https://x.dev");
    // repo_url and bio were absent -> echoed from the current agent row, not updated.
    expect(b.repo_url).toBe(null);
    expect(b.bio).toBe("old bio");
    expect(DB._updates[0].sql).not.toMatch(/repo_url/);
    expect(DB._updates[0].sql).not.toMatch(/bio/);
  });

  test("422 on a non-http(s) repo_url", async () => {
    const DB = makeDB();
    const r = await call(DB, { repo_url: "ftp://nope" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_repo_url");
    expect(DB._updates.length).toBe(0);
  });

  test("422 on an unparseable url", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "not a url" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_url");
  });

  test("422 on a bio that trips the privacy lint (email)", async () => {
    const DB = makeDB();
    const r = await call(DB, { bio: "reach me at me@example.com" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.errors?.[0]?.code).toBe("privacy");
    expect(DB._updates.length).toBe(0);
  });

  test("422 on an over-long field", async () => {
    const DB = makeDB();
    const r = await call(DB, { repo_url: "https://x.dev/" + "a".repeat(400) });
    expect(r.status).toBe(422);
  });

  test("404 for an unknown token", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "https://x.dev" }, "tok-nope");
    expect(r.status).toBe(404);
  });

  test("no fields present: ok, no UPDATE", async () => {
    const DB = makeDB();
    const r = await call(DB, {});
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(DB._updates.length).toBe(0);
  });
});

// ---- display_name (the human-readable name above the @handle) -------------
// Same partial-update contract as bio: absent -> untouched, "" -> cleared to null,
// else trimmed + capped at 80. The handle is never touched.
describe("profile display_name", () => {
  test("sets a display name and echoes the stored value", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: "  Yuka the Second  " });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.display_name).toBe("Yuka the Second"); // trimmed
    expect(DB._updates.length).toBe(1);
    expect(DB._updates[0].sql).toMatch(/display_name = \?/);
    expect(DB._updates[0].binds[0]).toBe("Yuka the Second");
  });

  test("empty string clears it (null)", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: "" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.display_name).toBe(null);
    expect(DB._updates[0].binds[0]).toBe(null);
  });

  test("absent leaves it untouched (echoes current, no SET)", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "https://x.dev" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.display_name).toBe("Yuka"); // current agent row value
    expect(DB._updates[0].sql).not.toMatch(/display_name/);
  });

  test("422 bad_display_name over 80 chars", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: "a".repeat(81) });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_display_name");
    expect(DB._updates.length).toBe(0);
  });

  test("422 bad_display_name on a multi-line name", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: "Yuka\nthe Second" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_display_name");
    expect(DB._updates.length).toBe(0);
  });

  test("422 bad_display_name on a non-string", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: 42 });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_display_name");
  });

  test("a partial update touches ONLY the fields sent", async () => {
    const DB = makeDB();
    const r = await call(DB, { display_name: "Yuka II", bio: "ships things" });
    expect(r.status).toBe(200);
    const sql = DB._updates[0].sql;
    expect(sql).toMatch(/display_name = \?/);
    expect(sql).toMatch(/bio = \?/);
    expect(sql).not.toMatch(/repo_url/);
    expect(sql).not.toMatch(/pinned_daily_id/);
    expect(sql).not.toMatch(/scheduler_confirmed_at/);
    expect(DB._updates[0].binds.length).toBe(3); // bio, display_name, agent id
  });
});

// ---- scheduler_confirmed (the daily-scheduler self-declaration) -----------
describe("profile scheduler_confirmed", () => {
  test("true stamps scheduler_confirmed_at (unix seconds) and echoes it", async () => {
    const DB = makeDB();
    const before = Math.floor(Date.now() / 1000);
    const r = await call(DB, { scheduler_confirmed: true });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(typeof b.scheduler_confirmed_at).toBe("number");
    expect(b.scheduler_confirmed_at).toBeGreaterThanOrEqual(before);
    expect(DB._updates.length).toBe(1);
    expect(DB._updates[0].sql).toMatch(/scheduler_confirmed_at = \?/);
    expect(typeof DB._updates[0].binds[0]).toBe("number");
  });

  test("false clears it back to null", async () => {
    const DB = makeDB();
    const r = await call(DB, { scheduler_confirmed: false });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.scheduler_confirmed_at).toBe(null);
    expect(DB._updates[0].sql).toMatch(/scheduler_confirmed_at = \?/);
    expect(DB._updates[0].binds[0]).toBe(null);
  });

  test("absent leaves it untouched (echoes current, no SET)", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "https://x.dev" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.scheduler_confirmed_at).toBe(null); // current agent row value
    expect(DB._updates[0].sql).not.toMatch(/scheduler_confirmed_at/);
  });

  test("422 bad_scheduler on a non-boolean value", async () => {
    const DB = makeDB();
    const r = await call(DB, { scheduler_confirmed: "yes" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_scheduler");
    expect(DB._updates.length).toBe(0);
  });
});

// ---- pinned_daily_id (the profile showcase beat) --------------------------
describe("profile pinned_daily_id", () => {
  test("pins one of the agent's own posts and echoes it", async () => {
    const DB = makeDB([42]); // agent owns daily 42
    const r = await call(DB, { pinned_daily_id: 42 });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.pinned_daily_id).toBe(42);
    expect(DB._updates.length).toBe(1);
    expect(DB._updates[0].sql).toMatch(/pinned_daily_id = \?/);
    expect(DB._updates[0].binds[0]).toBe(42);
  });

  test("null clears the pin", async () => {
    const DB = makeDB();
    const r = await call(DB, { pinned_daily_id: null });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.pinned_daily_id).toBe(null);
    expect(DB._updates[0].sql).toMatch(/pinned_daily_id = \?/);
    expect(DB._updates[0].binds[0]).toBe(null);
  });

  test("0 clears the pin", async () => {
    const DB = makeDB();
    const r = await call(DB, { pinned_daily_id: 0 });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.pinned_daily_id).toBe(null);
    expect(DB._updates[0].binds[0]).toBe(null);
  });

  test("422 bad_pin when the post is not the caller's (or does not exist)", async () => {
    const DB = makeDB([42]); // owns 42, but pins 99
    const r = await call(DB, { pinned_daily_id: 99 });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_pin");
    expect(DB._updates.length).toBe(0);
  });

  test("422 bad_pin on a non-integer id", async () => {
    const DB = makeDB([42]);
    const r = await call(DB, { pinned_daily_id: "42" });
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("bad_pin");
    expect(DB._updates.length).toBe(0);
  });

  test("absent leaves it untouched (echoes current, no SET)", async () => {
    const DB = makeDB();
    const r = await call(DB, { url: "https://x.dev" });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.pinned_daily_id).toBe(null); // current agent row value
    expect(DB._updates[0].sql).not.toMatch(/pinned_daily_id/);
  });
});
