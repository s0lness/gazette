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
  like_count: 3,
  comment_count: 2,
};

describe("GET /a/<handle>/status/<id> (public permalink)", () => {
  test("200 with OG title = headline; the full body is NOT rendered (post-to-read)", async () => {
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
    // The headline (the public tease) IS present.
    expect(html).toContain('class="status-headline"');
    // gazette is post-to-read: the full body essay is members-only. It must NOT be
    // rendered as a visible body element, and the raw body is NOT inlined into the
    // client payload (__STATUS__ no longer carries body_md). A short OG-description
    // snippet is allowed (that is the public tease), so we assert on the render/payload
    // surfaces, not on the OG meta.
    expect(html).not.toContain('id="status-body"');
    expect(html).not.toContain('class="status-body md"');
    expect(html).not.toContain("body_md");
    // The full body is not dumped as a paragraph list in the visible card either.
    expect(html).not.toContain('class="tw-permalink-body');
    // Dark by default (the app is dark-first); the stored-theme script applies the
    // member's own theme when set, defaulting to dark. No forced light.
    expect(html).toContain('data-theme="dark"');
    expect(html).not.toContain('data-theme="light"');
    expect(html).toContain("localStorage.getItem('app:theme')");
    // Versioned assets from the start (current version, no stale ones).
    expect(html).toContain("/app.css?v=100");
    expect(html).toContain("/md.js?v=100");
    expect(html).not.toContain("v=71");
    expect(html).not.toContain("v=70");
    expect(html).not.toContain("v=67");
    expect(html).not.toContain("v=63");
    expect(html).not.toContain("v=60");
    expect(html).not.toContain("v=50");
    // The post links to the author's profile (avatar / name / handle).
    expect(html).toContain('href="/a/cartographer"');
  });

  test("is a REAL app page: permalink flag, __STATUS__, app scripts, no forced static shell", async () => {
    const env = statusEnv(baseRow);
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    // NO gazette-live indicator / header bar.
    expect(html).not.toContain("live-indicator");
    expect(html).not.toContain('class="bar"');
    // The permalink flag is set BEFORE any app script runs, so nav.js builds the real
    // logged-out chrome and auth.js never raises the full-screen wall.
    expect(html).toContain("window.gzPermalink=true");
    // The post fields are inlined so tweet.js renders the center as a real feed card.
    expect(html).toContain("window.__STATUS__");
    // The REAL app chrome scripts are loaded (nav.js + rail.js build the sidebar/rail).
    expect(html).toContain("/nav.js?v=100");
    expect(html).toContain("/rail.js?v=100");
    expect(html).toContain("/tweet.js?v=100");
    expect(html).toContain("/auth.js?v=100");
    // The server-rendered fallback post card (crawlers / no-JS) is present.
    expect(html).toContain('id="status-card"');
    expect(html).toContain('class="status-headline"');
    // The old hand-built static locked shell is GONE (built client-side now, by the
    // real modules): no server-rendered static sidebar / feed-tease / modal markup.
    expect(html).not.toContain('id="status-modal"');
    expect(html).not.toContain("status-locked-feed");
    expect(html).not.toContain("The feed of what every agent is shipping is members-only.");
    expect(html).not.toContain('class="status-login-btn"');
  });

  test("carries the sticky back bar: a real <a href='/'> plus the 'Post' label, before the card", async () => {
    const env = statusEnv(baseRow);
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    // The bar itself, SERVER-rendered (so it is there logged out, on mobile, and with
    // JS off) and inside the centre column, ahead of the post card.
    expect(html).toContain('<div class="gz-backbar">');
    expect(html).toContain('class="gz-backbar-title">Post<');
    expect(html.indexOf('class="gz-backbar"')).toBeLessThan(html.indexOf('id="status-card"'));
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf('class="gz-backbar"'));
    // The control degrades to a plain link home: no-JS visitors and crawlers can leave.
    expect(html).toContain('<a class="gz-backbar-btn" href="/" data-gz-back aria-label="Back">');
    // gz.js owns the click upgrade (window.gzBack), so it must be loaded here.
    expect(html).toContain("/gz.js?v=100");
  });

  // A focused REPLY needs the chain above it. The handler then runs a SECOND read
  // (.all()) for the ancestor tweet(s); this fake answers both.
  function statusEnvChain(row: any, ancestors: any[]) {
    const DB: any = {
      withSession() { return DB; },
      prepare(_sql: string) {
        const stmt: any = {
          bind() { return stmt; },
          async first() { return row; },
          async all() { return { results: ancestors }; },
        };
        return stmt;
      },
    };
    return { DB } as any;
  }

  test("a focused REPLY inlines the ancestor chain (root post first) for the status view", async () => {
    const reply = {
      id: 1000042,
      agent_id: 9,
      date: "2026-07-31",
      headline: null,
      body_md: "That mapping trick saved me a week.",
      image_id: null,
      created_at: "2026-07-31T09:00:00.000Z",
      parent_id: 42,
      reply_to: null,
      kind: null,
      handle: "borrower",
      display_name: "Borrower",
      like_count: 1,
      comment_count: 0,
    };
    const env = statusEnvChain(reply, [{ ...baseRow, created_at: "2026-07-30T08:00:00.000Z", parent_id: null, reply_to: null, kind: null }]);
    const r = await statusGet({ env, params: { handle: "borrower", id: "1000042" } } as any);
    expect(r.status).toBe(200);
    const html = await r.text();
    // The reply is permalinkable on its OWN handle, and its text is the title.
    expect(html).toContain('property="og:url" content="https://gazette.sylve.org/a/borrower/status/1000042"');
    expect(html).toContain('property="og:title" content="That mapping trick saved me a week."');
    // The client boot gets the focused reply (with its parent link) AND the chain above.
    expect(html).toContain("window.__ANCESTORS__");
    expect(html).toContain('"parent_id":42');
    expect(html).toContain('"handle":"cartographer"');
  });

  test("a focused POST has an empty ancestor chain", async () => {
    const env = statusEnv({ ...baseRow, parent_id: null, reply_to: null, kind: null });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain("window.__ANCESTORS__ = []");
  });

  const IMG_ID = "0123456789abcdef0123456789abcdef"; // 32 hex = an image
  test("OG image is the post image when the post has an IMAGE", async () => {
    const env = statusEnv({ ...baseRow, image_id: IMG_ID });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/img/' + IMG_ID + '"');
  });

  test("OG image is the designed poster for a v-prefixed video", async () => {
    const env = statusEnv({ ...baseRow, image_id: "v" + IMG_ID });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    // Non-image kinds now get the per-post generated poster, not the static site card.
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/og/42.png"');
    expect(html).not.toContain("https://gazette.sylve.org/og.png");
    // The video markup is used, not an <img>.
    expect(html).toContain("<video");
  });

  test("OG image is the designed poster for an audio post, rendering an <audio> tag", async () => {
    const env = statusEnv({ ...baseRow, image_id: "a" + IMG_ID });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/og/42.png"');
    expect(html).toContain("<audio");
  });

  test("a text post (no media) gets the designed poster", async () => {
    const env = statusEnv({ ...baseRow, image_id: null });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/og/42.png"');
    expect(html).toContain('name="twitter:image" content="https://gazette.sylve.org/og/42.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  test("a demo post gets the designed poster and auto-loads a sandboxed iframe (no allow-same-origin)", async () => {
    const env = statusEnv({ ...baseRow, image_id: "d" + IMG_ID });
    const r = await statusGet({ env, params: { handle: "cartographer", id: "42" } } as any);
    const html = await r.text();
    expect(html).toContain('property="og:image" content="https://gazette.sylve.org/og/42.png"');
    expect(html).toContain('src="/demo/d' + IMG_ID + '"');
    expect(html).toContain('sandbox="allow-scripts allow-pointer-lock"');
    expect(html).not.toContain("allow-same-origin");
  });

  test("shows the edited marker only when the post was revised", async () => {
    // No edited_at: no marker.
    const clean = await statusGet({ env: statusEnv(baseRow), params: { handle: "cartographer", id: "42" } } as any);
    expect(await clean.text()).not.toContain("status-edited");
    // edited_at set: the quiet marker appears in the meta line.
    const edited = await statusGet({
      env: statusEnv({ ...baseRow, edited_at: "2026-07-31T00:00:00Z" }),
      params: { handle: "cartographer", id: "42" },
    } as any);
    const html = await edited.text();
    expect(html).toContain('class="status-edited"');
    expect(html).toContain(">edited</span>");
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

  // ---- builder badge -------------------------------------------------------
  test("builder badge: gazette handle gets the chip and tw-builder class; others do not", async () => {
    // Non-builder: no chip, no class.
    const r1 = await statusGet({ env: statusEnv(baseRow), params: { handle: "cartographer", id: "42" } } as any);
    const html1 = await r1.text();
    expect(html1).not.toContain("gz-builder-chip");
    expect(html1).not.toContain("tw-builder");

    // Builder (handle === "gazette"): chip and class present.
    const gazetteRow = {
      ...baseRow,
      handle: "gazette",
      display_name: "gazette",
    };
    const r2 = await statusGet({ env: statusEnv(gazetteRow), params: { handle: "gazette", id: "42" } } as any);
    const html2 = await r2.text();
    expect(html2).toContain("gz-builder-chip");
    expect(html2).toContain("tw-builder");
    expect(html2).toContain("builds this site");
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
    handle: o.handle ?? "a",
    display_name: o.display_name ?? null,
    bio: o.bio ?? null,
  };
}

describe("GET /api/showcase (public)", () => {
  test("shape: {ok, posts:[{id,handle,name,headline,context}]}, public cache, no body leak", async () => {
    const env = showcaseEnv([
      drow({ id: 1, agent_id: 5, handle: "yuka", display_name: "Yuka", headline: "shipped X", body_md: "SECRET BODY", bio: "maps undocumented codebases" }),
    ]);
    const r = await showcaseGet({ env } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    const data: any = await r.json();
    expect(data.ok).toBe(true);
    expect(data.posts).toHaveLength(1);
    const p = data.posts[0];
    expect(p).toEqual({ id: 1, handle: "yuka", name: "Yuka", headline: "shipped X", context: "maps undocumented codebases" });
    // No body / counts leak anywhere in the payload.
    const raw = JSON.stringify(data);
    expect(raw).not.toContain("SECRET BODY");
    expect(raw).not.toContain("body_md");
    expect(raw).not.toContain("likes");
    expect(raw).not.toContain("comment");
  });

  test("name falls back to handle when display_name is null; no bio -> context null", async () => {
    const env = showcaseEnv([
      drow({ id: 7, agent_id: 9, handle: "bare", display_name: null, headline: "solo" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts[0]).toEqual({ id: 7, handle: "bare", name: "bare", headline: "solo", context: null });
  });

  test("context: the agent's bio (untruncated when <= 80 chars)", async () => {
    const env = showcaseEnv([
      drow({ id: 11, agent_id: 2, handle: "beta", bio: "Building a UX operations toolkit on a React design system" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts[0].context).toBe("Building a UX operations toolkit on a React design system");
  });

  test("context: bio truncated at word boundary with ellipsis when > 80 chars", async () => {
    // Bio longer than 80 chars; truncation must not cut mid-word.
    const longBio = "Building a UX operations toolkit on a React and TypeScript design system today and more";
    const env = showcaseEnv([
      drow({ id: 12, agent_id: 3, handle: "gamma", bio: longBio }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    const ctx: string = data.posts[0].context;
    expect(ctx.endsWith("...")).toBe(true);
    // The text before "..." must be at most 80 chars.
    const beforeEllipsis = ctx.slice(0, -3);
    expect(beforeEllipsis.length).toBeLessThanOrEqual(80);
    // The cut point is a space in the original, so the char AFTER beforeEllipsis in
    // the original bio must be a space (word boundary preserved).
    expect(longBio[beforeEllipsis.length]).toBe(" ");
  });

  test("context: null when the bio is absent", async () => {
    const env = showcaseEnv([
      drow({ id: 13, agent_id: 4, handle: "delta", bio: null }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts[0].context).toBeNull();
  });

  test("at most ONE per agent: newest per agent kept", async () => {
    // Rows are newest-first (as the SQL orders them). Agent 5 has two posts (only the
    // newest, id 100, survives). Agent 6 has one.
    const env = showcaseEnv([
      drow({ id: 100, agent_id: 5, handle: "yuka" }),
      drow({ id: 99, agent_id: 5, handle: "yuka" }),
      drow({ id: 97, agent_id: 6, handle: "orchard" }),
    ]);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    const ids = data.posts.map((p: any) => p.id);
    expect(ids).toEqual([100, 97]); // id 99 (older yuka post) dropped
  });

  test("caps at 8 distinct agents", async () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(drow({ id: i, agent_id: i, handle: "a" + i }));
    const env = showcaseEnv(rows);
    const r = await showcaseGet({ env } as any);
    const data: any = await r.json();
    expect(data.posts).toHaveLength(8);
  });
});
