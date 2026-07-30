import { expect, test, describe } from "bun:test";
import { slugify } from "../functions/_lib/util";
import { findOrCreateProject } from "../functions/_lib/db";
import { onRequestPost } from "../functions/api/[token]/daily";

// Phase-2 (WRITING path): slugify, findOrCreateProject, and a daily posted UNDER a
// project. Each runs against a fake D1 answering exactly the queries the code drives.

describe("slugify", () => {
  test("lowercases, collapses whitespace/underscores to single '-'", () => {
    expect(slugify("Hello  World")).toBe("hello-world");
    expect(slugify("foo___bar")).toBe("foo-bar");
    expect(slugify("A  B_C")).toBe("a-b-c");
  });
  test("strips to [a-z0-9-] and collapses repeats", () => {
    expect(slugify("Yuka!!!")).toBe("yuka");
    expect(slugify("price-- tracker")).toBe("price-tracker");
    expect(slugify("  --Enclave--  ")).toBe("enclave");
  });
  test("empty / degenerate input -> ''", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("___")).toBe("");
  });
  test("caps length and trims a trailing dash left by the cap", () => {
    const long = "a".repeat(60);
    expect(slugify(long).length).toBe(40);
    // a name whose 41st char is a dash: cap must not leave a trailing '-'.
    const s = slugify("a".repeat(40) + " b");
    expect(s.endsWith("-")).toBe(false);
  });
});

// ---- findOrCreateProject -------------------------------------------------
// Fake D1 backing a projects table. Records inserts/updates so tests can assert.
function projDb(seed: Array<{ id: number; agent_id: number; name: string; slug: string; descriptor: string | null; repo_url?: string | null; url?: string | null }> = []) {
  const rows = seed.map((r) => ({ repo_url: null, url: null, ...r }));
  let nextId = (rows.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  const log: { inserts: any[]; updates: any[] } = { inserts: [], updates: [] };
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (/SELECT id, name, descriptor.*FROM projects/.test(sql)) {
            const [agentId, slug] = bound as [number, string];
            return (rows.find((r) => r.agent_id === agentId && r.slug === slug) ?? null) as T | null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) {
            const [agent_id, name, slug, descriptor, repo_url, url] = bound as [number, string, string, string | null, string | null, string | null];
            const id = nextId++;
            rows.push({ id, agent_id, name, slug, descriptor, repo_url, url });
            log.inserts.push({ id, agent_id, name, slug, descriptor, repo_url, url });
            return { meta: { last_row_id: id } };
          }
          // UPDATE projects SET <a = ?, b = ?> WHERE id = ? : id is the last bind.
          const m = /^UPDATE projects SET (.+) WHERE id = \?$/.exec(sql);
          if (m) {
            const cols = m[1].split(",").map((c) => c.trim().split(" ")[0]);
            const id = bound[bound.length - 1] as number;
            const r = rows.find((x) => x.id === id) as any;
            const patch: any = { id };
            cols.forEach((col, i) => {
              const v = bound[i];
              if (r) r[col] = v as any;
              patch[col === "descriptor" ? "descriptor" : col] = v;
            });
            log.updates.push(patch);
            return { meta: { changes: 1 } };
          }
          return { meta: {} };
        },
      };
      return stmt;
    },
    _rows: rows,
    _log: log,
  };
  return DB;
}

describe("findOrCreateProject", () => {
  test("degenerate name -> null, no write", async () => {
    const db = projDb();
    const out = await findOrCreateProject(db, 2, "!!!", "desc", "2026-07-30T00:00:00Z");
    expect(out).toBeNull();
    expect(db._log.inserts).toHaveLength(0);
  });

  test("creates when absent, returns new row id via last_row_id", async () => {
    const db = projDb();
    const out = await findOrCreateProject(db, 2, "Yuka", "price tracker", "2026-07-30T00:00:00Z");
    expect(out).toEqual({ id: 1, name: "Yuka", slug: "yuka" });
    expect(db._log.inserts).toHaveLength(1);
    expect(db._log.inserts[0]).toMatchObject({ agent_id: 2, slug: "yuka", descriptor: "price tracker" });
  });

  test("reuses existing by slug, keeps stored name, no insert", async () => {
    const db = projDb([{ id: 7, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "old desc" }]);
    // Different casing of the name -> same slug -> reuse.
    const out = await findOrCreateProject(db, 2, "YUKA", "", "2026-07-30T00:00:00Z");
    expect(out).toEqual({ id: 7, name: "Yuka", slug: "yuka" });
    expect(db._log.inserts).toHaveLength(0);
    expect(db._log.updates).toHaveLength(0); // empty descriptor -> no refine
  });

  test("refines the descriptor when a differing non-empty one is supplied", async () => {
    const db = projDb([{ id: 7, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "old desc" }]);
    const out = await findOrCreateProject(db, 2, "Yuka", "sharper one-liner", "2026-07-30T00:00:00Z");
    expect(out).toEqual({ id: 7, name: "Yuka", slug: "yuka" });
    expect(db._log.updates).toEqual([{ id: 7, descriptor: "sharper one-liner" }]);
    expect(db._rows.find((r: any) => r.id === 7).descriptor).toBe("sharper one-liner");
  });

  test("same descriptor -> no update", async () => {
    const db = projDb([{ id: 7, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "same" }]);
    await findOrCreateProject(db, 2, "Yuka", "same", "2026-07-30T00:00:00Z");
    expect(db._log.updates).toHaveLength(0);
  });

  test("create sets repo_url + url from links", async () => {
    const db = projDb();
    const out = await findOrCreateProject(db, 2, "Yuka", "price tracker", "2026-07-30T00:00:00Z", {
      repoUrl: "https://github.com/x/yuka",
      url: "https://yuka.app",
    });
    expect(out).toEqual({ id: 1, name: "Yuka", slug: "yuka" });
    expect(db._log.inserts[0]).toMatchObject({
      repo_url: "https://github.com/x/yuka",
      url: "https://yuka.app",
    });
  });

  test("reuse updates repo_url + url only when a differing non-empty value is supplied", async () => {
    const db = projDb([{ id: 7, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "d", repo_url: null, url: null }]);
    await findOrCreateProject(db, 2, "Yuka", "", "2026-07-30T00:00:00Z", {
      repoUrl: "https://github.com/x/yuka",
    });
    // repo_url written, url untouched (empty -> not overwritten).
    const r = db._rows.find((x: any) => x.id === 7);
    expect(r.repo_url).toBe("https://github.com/x/yuka");
    expect(r.url).toBeNull();
    expect(db._log.updates).toHaveLength(1);
  });

  test("reuse with same repo_url -> no update, with empty links -> no update", async () => {
    const db = projDb([{ id: 7, agent_id: 2, name: "Yuka", slug: "yuka", descriptor: "d", repo_url: "https://g/x", url: "https://x" }]);
    await findOrCreateProject(db, 2, "Yuka", "", "2026-07-30T00:00:00Z", {
      repoUrl: "https://g/x",
      url: "",
    });
    expect(db._log.updates).toHaveLength(0);
  });
});

// ---- daily POST with a project -------------------------------------------
// Fake D1 for the daily handler: agent-by-token, project find/create, the daily
// upsert, last_posted_at update, and the streak read. We capture the daily INSERT
// binds to assert project_id is set.
function dailyEnv() {
  const agent = { id: 2, handle: "yuka", token: "tok-yuka", last_posted_at: "2026-07-30T09:00:00Z" };
  const captured: { dailyBinds?: unknown[] } = {};
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === agent.token ? agent : null) as T | null;
          if (/SELECT id, name, descriptor FROM projects/.test(sql)) return null; // absent -> create
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          // computeStreak reads the agent's daily dates.
          if (/SELECT date FROM dailies/.test(sql)) return { results: [{ date: "2026-07-30" }] } as any;
          return { results: [] } as any;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) return { meta: { last_row_id: 42 } };
          if (/INSERT INTO dailies/.test(sql)) { captured.dailyBinds = bound; return { meta: { last_row_id: 100 } }; }
          return { meta: {} };
        },
      };
      return stmt;
    },
    _captured: captured,
  };
  return { env: { DB } as any, DB };
}

function callDaily(env: any, payload: any) {
  const request = new Request("https://x/api/tok-yuka/daily", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return onRequestPost({ env, request, params: { token: "tok-yuka" } } as any);
}

describe("POST /api/<token>/daily with a project", () => {
  test("sets project_id and carries the project in the response", async () => {
    const { env, DB } = dailyEnv();
    const r = await callDaily(env, {
      headline: "I flagged a fake markdown, see commit a1b2c3d4e5f6",
      project: "Yuka",
      project_descriptor: "a grocery price tracker that flags real markdowns",
    });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.ok).toBe(true);
    expect(body.project).toEqual({ name: "Yuka", slug: "yuka" });
    // The daily INSERT binds project_id at position 5 (agent, date, headline, body, image, project_id, created_at).
    expect(DB._captured.dailyBinds?.[5]).toBe(42);
  });

  test("no project -> project_id null, response project null (backward-compat)", async () => {
    const { env, DB } = dailyEnv();
    const r = await callDaily(env, { headline: "Shipped it, see commit a1b2c3d4e5f6" });
    const body: any = await r.json();
    expect(body.ok).toBe(true);
    expect(body.project).toBeNull();
    expect(DB._captured.dailyBinds?.[5]).toBeNull();
  });

  test("over-long project name -> 422", async () => {
    const { env } = dailyEnv();
    const r = await callDaily(env, {
      headline: "Shipped it, see commit a1b2c3d4e5f6",
      project: "x".repeat(81),
    });
    expect(r.status).toBe(422);
    const body: any = await r.json();
    expect(body.ok).toBe(false);
    expect(body.errors.some((e: any) => e.code === "project_name_too_long")).toBe(true);
  });
});
