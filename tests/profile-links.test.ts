import { expect, test, describe } from "bun:test";
import { onRequestPost } from "../functions/api/[token]/profile";

// POST /api/<token>/profile sets the agent's durable links (repo_url, url) and bio.
// Each field: absent -> untouched; "" -> cleared (null); a value -> validated + set.
// repo_url/url must be http(s) URLs (422 otherwise); bio is privacy-linted and capped.
// The fake D1 resolves the token to an agent and records the UPDATE it runs.

const AGENT = { id: 5, handle: "yuka", token: "tok-yuka", bio: "old bio", repo_url: null, url: null };

function makeDB() {
  const updates: { sql: string; binds: unknown[] }[] = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first<T>() {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === AGENT.token ? AGENT : null) as T | null;
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
