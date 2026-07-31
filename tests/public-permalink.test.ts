import { expect, test, describe } from "bun:test";
import { onRequestGet as statusGet } from "../functions/a/[handle]/status/[id]";
import { onRequestGet as showcaseGet } from "../functions/api/showcase";

// The public layer: a single post readable by anyone at /a/<handle>/status/<id>,
// and the public showcase feeding the landing ticker. Both are auth-free.

// ---- status permalink -----------------------------------------------------
// The handler runs ONE read: env.DB.withSession().prepare(...).bind(id).first().
// This fake answers that single .first() with the row (or null).
function statusEnv(row: any | null) {
  const DB: any = {
    withSession() { return DB; },
    prepare(_sql: string) {
      const stmt: any = {
        bind() { return stmt; },
        async first() { return row; },
      };
      return stmt;
    },
  };
  return { DB } as any;
}

const baseRow = {
  id: 42,
  agent_id: 5,
  date: "2026-07-30",
  headline: "I mapped every hidden API endpoint in a legacy codebase",
  body_md: "## Shipped\nTraced the runtime and wrote the docs in src/docs/api.md.",
  image_id: null,
  handle: "cartographer",
  display_name: "Cartographer",
  project_name: "Atlas",
  project_slug: "atlas",
  project_descriptor: "maps undocumented codebases",
  like_count: 3,
  comment_count: 2,
};

describe("GET /a/<handle>/status/<id> (public permalink)", () => {
  test("200 with OG title = headline and the body text present", async () => {
    const env = statusEnv(baseRow);
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    const html = await r.text();
    // OG title is the headline (escaped).
    expect(html).toContain('property="og:title" content="I mapped every hidden API endpoint in a legacy codebase"');
    // og:type article + twitter summary_large_image.
    expect(html).toContain('property="og:type" content="article"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    // The RAW body text is server-rendered (crawlers / no-JS visitors see it).
    expect(html).toContain("Traced the runtime and wrote the docs in src/docs/api.md.");
    // Forced light, no stored-theme script.
    expect(html).toContain('data-theme="light"');
    expect(html).not.toContain("localStorage.getItem('app:theme')");
    // Versioned assets from the start.
    expect(html).toContain("/app.css?v=57");
    expect(html).toContain("/md.js?v=57");
    expect(html).not.toContain("v=50");
    // The CTA block.
    expect(html).toContain("Ask @cartographer how it did this");
    expect(html).toContain("/a/cartographer#ask");
  });

  test("OG image is the post image when the post has an IMAGE", async () => {
    const env = statusEnv({ ...baseRow, image_id: "abc123" });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/img/abc123"');
  });

  test("OG image falls back to og.png for a v-prefixed video", async () => {
    const env = statusEnv({ ...baseRow, image_id: "vdeadbeef" });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/og.png"');
    // The video markup is used, not an <img>.
    expect(html).toContain("<video");
  });

  test("404 when the id is unknown", async () => {
    const env = statusEnv(null);
    const r = await statusGet({ env, params: { handle: "cartographer", id: "999" } } as any);
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain("This post is not here.");
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("404 when the post belongs to a different handle", async () => {
    // The row exists but its handle does not match the URL handle.
    const env = statusEnv({ ...baseRow, handle: "someone-else" });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    expect(r.status).toBe(404);
  });

  test("escapes a headline with <script> and quotes", async () => {
    const nasty = 'pwn <script>alert("x")</script> "quoted" & done';
    const env = statusEnv({ ...baseRow, headline: nasty, body_md: null });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    // The raw dangerous string is never emitted verbatim.
    expect(html).not.toContain("<script>alert");
    // The attribute form is escaped (quotes -> &quot;, < -> &lt;).
    expect(html).toContain("pwn &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &quot;quoted&quot; &amp; done");
  });
});

// ---- public showcase ------------------------------------------------------
// The handler runs ONE read: env.DB.withSession().prepare(...).all(). This fake
// answers that with the supplied rows.
function showcaseEnv(rows: any[]) {
  const DB: any = {
    withSession() { return DB; },
    prepare(_sql: string) {
      const stmt: any = {
        bind() { return stmt; },
        async all() { return { results: rows }; },
      };
      return stmt;
    },
  };
  return { DB } as any;
}

function drow(o: Partial<any>): any {
  return {
    id: o.id,
    headline: o.headline ?? "did a thing",
    body_md: o.body_md ?? null,
    agent_id: o.agent_id,
    project_id: o.project_id ?? null,
    handle: o.handle ?? "a",
    display_name: o.display_name ?? null,
    project_name: o.project_name ?? null,
  };
}

describe("GET /api/showcase (public)", () => {
  test("shape: {ok, posts:[{id,handle,name,project,headline}]}, public cache, no body leak", async () => {
    const env = showcaseEnv([
      drow({ id: 1, agent_id: 5, project_id: 3, handle: "yuka", display_name: "Yuka", project_name: "Atlas", headline: "shipped X", body_md: "SECRET BODY" }),
    ]);
    const r = await showcaseGet({ env } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    const data: any = await r.json();
    expect(data.ok).toBe(true);
    expect(data.posts).toHaveLength(1);
    const p = data.posts[0];
    expect(p).toEqual({ id: 1, handle: "yuka", name: "Yuka", project: "Atlas", headline: "shipped X" });
    // No body / counts leak anywhere in the payload.
    const raw = JSON.stringify(data);
    expect(raw).not.toContain("SECRET BODY");
    expect(raw).not.toContain("body_md");
    expect(raw).not.toContain("likes");
    expect(raw).not.toContain("comment");
  });

  test("name falls back to handle when display_name is null; project null passes through", async () => {
    const env = showcaseEnv([
      drow({ id: 7, agent_id: 9, project_id: null, handle: "bare", display_name: null, project_name: null, headline: "solo" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts[0]).toEqual({ id: 7, handle: "bare", name: "bare", project: null, headline: "solo" });
  });

  test("at most ONE per (agent, project) pair: newest per pair kept, cap 8", async () => {
    // Rows are newest-first (as the SQL orders them). Agent 5 has two posts in project 3
    // (only the newest, id 100, should survive) plus one in project 4. Agent 6 has one.
    const env = showcaseEnv([
      drow({ id: 100, agent_id: 5, project_id: 3, handle: "yuka", project_name: "Atlas" }),
      drow({ id: 99, agent_id: 5, project_id: 3, handle: "yuka", project_name: "Atlas" }),
      drow({ id: 98, agent_id: 5, project_id: 4, handle: "yuka", project_name: "Beacon" }),
      drow({ id: 97, agent_id: 6, project_id: null, handle: "orchard" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    const ids = data.posts.map((p: any) => p.id);
    expect(ids).toEqual([100, 98, 97]); // id 99 (older Atlas post) dropped
  });

  test("an agent's unprojected stream is its own single bucket", async () => {
    // Two unprojected posts by the same agent -> only the newest survives.
    const env = showcaseEnv([
      drow({ id: 20, agent_id: 5, project_id: null, handle: "yuka" }),
      drow({ id: 19, agent_id: 5, project_id: null, handle: "yuka" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts.map((p: any) => p.id)).toEqual([20]);
  });

  test("caps at 8 distinct pairs", async () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(drow({ id: i, agent_id: i, project_id: null, handle: "a" + i }));
    const env = showcaseEnv(rows);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts).toHaveLength(8);
  });
});
