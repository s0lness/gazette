import { expect, test, describe } from "bun:test";
import { onRequestPost as masterImage } from "../functions/api/[token]/image";
import { onRequestPost as projectImage } from "../functions/api/p/[ptoken]/image";

// Media upload (image + video) on BOTH the master-token route and the write-only
// project-token route. A fake D1 answers the agent/token lookups; a fake R2 (IMG)
// records what was stored so the test can assert the content-type + key shape. Video
// ids are PREFIXED "v"; images stay 32 hex.

const MASTER = "tok-master";
const AGENT = { id: 2, handle: "yuka", display_name: "Yuka", bio: null, token: MASTER, created_at: "x", last_posted_at: null };
const GZP = "gzp_0123456789abcdef0123456789abcdef";

function makeEnv() {
  const puts: Array<{ key: string; contentType: string; bytes: number }> = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (/SELECT \* FROM agents WHERE token/.test(sql)) return (bound[0] === MASTER ? AGENT : null) as T | null;
          if (/SELECT \* FROM agents WHERE id/.test(sql)) return (bound[0] === AGENT.id ? AGENT : null) as T | null;
          if (/FROM project_tokens pt JOIN projects p/.test(sql)) {
            if (bound[0] !== GZP) return null;
            return {
              token_id: 1,
              revoked_at: null,
              project_id: 5,
              project_name: "Yuka",
              project_slug: "yuka",
              agent_id: AGENT.id,
            } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> { return { results: [] } as any; },
        async run() { return { meta: {} }; },
      };
      return stmt;
    },
  };
  const IMG: any = {
    async put(key: string, buf: ArrayBuffer, opts: any) {
      puts.push({ key, contentType: opts?.httpMetadata?.contentType, bytes: buf.byteLength });
      return {};
    },
  };
  return { env: { DB, IMG } as any, puts };
}

function req(url: string, contentType: string, bytes: number) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(bytes),
  });
}

describe("master-token media upload POST /api/<token>/image", () => {
  test("accepts a PNG and returns a 32-hex image id (no v prefix)", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "image/png", 100), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^[0-9a-f]{32}$/);
    expect(puts[0].contentType).toBe("image/png");
  });

  test("accepts a video/mp4 and returns a v-prefixed id", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "video/mp4", 1000), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^v[0-9a-f]{32}$/);
    expect(puts[0].key).toBe(b.image_id);
    expect(puts[0].contentType).toBe("video/mp4");
  });

  test("accepts video/webm", async () => {
    const { env } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "video/webm", 1000), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^v[0-9a-f]{32}$/);
  });

  test("rejects a video over 8 MB with 413 too_large", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "video/mp4", 8 * 1024 * 1024 + 1), params: { token: MASTER } } as any);
    expect(r.status).toBe(413);
    const b: any = await r.json();
    expect(b.code).toBe("too_large");
    expect(puts).toHaveLength(0);
  });

  test("still enforces the 800 KB cap on images", async () => {
    const { env } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "image/png", 800 * 1024 + 1), params: { token: MASTER } } as any);
    expect(r.status).toBe(413);
  });

  test("rejects a wrong type (e.g. video/quicktime) with 415 bad_type", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "video/quicktime", 100), params: { token: MASTER } } as any);
    expect(r.status).toBe(415);
    const b: any = await r.json();
    expect(b.code).toBe("bad_type");
    expect(puts).toHaveLength(0);
  });

  // ---- GIF: image kind (32-hex id), 4 MB cap -----------------------------
  test("accepts a GIF up to 4 MB and returns a 32-hex image id (no prefix)", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "image/gif", 4 * 1024 * 1024), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^[0-9a-f]{32}$/);
    expect(puts[0].contentType).toBe("image/gif");
  });

  test("rejects a GIF over 4 MB with 413 too_large", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "image/gif", 4 * 1024 * 1024 + 1), params: { token: MASTER } } as any);
    expect(r.status).toBe(413);
    const b: any = await r.json();
    expect(b.code).toBe("too_large");
    expect(puts).toHaveLength(0);
  });

  // ---- Audio: prefix "a", content-type stored ----------------------------
  test("accepts audio/mpeg and returns an a-prefixed id, storing the type", async () => {
    const { env, puts } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "audio/mpeg", 1000), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^a[0-9a-f]{32}$/);
    expect(puts[0].key).toBe(b.image_id);
    expect(puts[0].contentType).toBe("audio/mpeg");
  });

  test("accepts audio/ogg and audio/wav", async () => {
    for (const ct of ["audio/ogg", "audio/wav"]) {
      const { env } = makeEnv();
      const r = await masterImage({ env, request: req("https://x/api/tok-master/image", ct, 1000), params: { token: MASTER } } as any);
      expect(r.status).toBe(200);
      const b: any = await r.json();
      expect(b.image_id).toMatch(/^a[0-9a-f]{32}$/);
    }
  });

  test("rejects audio over 8 MB with 413", async () => {
    const { env } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "audio/mpeg", 8 * 1024 * 1024 + 1), params: { token: MASTER } } as any);
    expect(r.status).toBe(413);
  });

  // ---- Demo: prefix "d", 2 MB cap, parent-reference tripwires ------------
  test("accepts a self-contained text/html demo and returns a d-prefixed id", async () => {
    const { env, puts } = makeEnv();
    const html = "<!doctype html><html><body><script>let x=1;</script></body></html>";
    const r = await masterImage({ env, request: new Request("https://x/api/tok-master/image", { method: "POST", headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) }), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^d[0-9a-f]{32}$/);
    expect(puts[0].key).toBe(b.image_id);
    expect(puts[0].contentType).toBe("text/html");
  });

  test("rejects a demo over 2 MB with 413 too_large", async () => {
    const { env } = makeEnv();
    const r = await masterImage({ env, request: req("https://x/api/tok-master/image", "text/html", 2 * 1024 * 1024 + 1), params: { token: MASTER } } as any);
    expect(r.status).toBe(413);
  });

  test("rejects a demo referencing window.parent with 422 demo_not_selfcontained", async () => {
    const { env, puts } = makeEnv();
    const html = "<script>window.parent.postMessage('x','*')</script>";
    const r = await masterImage({ env, request: new Request("https://x/api/tok-master/image", { method: "POST", headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) }), params: { token: MASTER } } as any);
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("demo_not_selfcontained");
    expect(puts).toHaveLength(0);
  });

  test("rejects a demo referencing window.top or document.cookie (case-insensitive)", async () => {
    for (const html of ["<script>WINDOW.TOP.location='x'</script>", "<script>var c=Document.Cookie</script>"]) {
      const { env } = makeEnv();
      const r = await masterImage({ env, request: new Request("https://x/api/tok-master/image", { method: "POST", headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) }), params: { token: MASTER } } as any);
      expect(r.status).toBe(422);
      const b: any = await r.json();
      expect(b.code).toBe("demo_not_selfcontained");
    }
  });
});

describe("project-token media upload POST /api/p/<gzp>/image", () => {
  test("accepts a video/mp4 and returns a v-prefixed id", async () => {
    const { env, puts } = makeEnv();
    const r = await projectImage({ env, request: req(`https://x/api/p/${GZP}/image`, "video/mp4", 1000), params: { ptoken: GZP } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^v[0-9a-f]{32}$/);
    expect(puts[0].contentType).toBe("video/mp4");
  });

  test("rejects an oversized video with 413", async () => {
    const { env } = makeEnv();
    const r = await projectImage({ env, request: req(`https://x/api/p/${GZP}/image`, "video/webm", 8 * 1024 * 1024 + 1), params: { ptoken: GZP } } as any);
    expect(r.status).toBe(413);
  });

  test("rejects a wrong type with 415", async () => {
    const { env } = makeEnv();
    const r = await projectImage({ env, request: req(`https://x/api/p/${GZP}/image`, "application/pdf", 100), params: { ptoken: GZP } } as any);
    expect(r.status).toBe(415);
  });

  test("accepts a GIF (image kind), audio (a prefix), and a demo (d prefix)", async () => {
    const { env: e1 } = makeEnv();
    const gif = await projectImage({ env: e1, request: req(`https://x/api/p/${GZP}/image`, "image/gif", 1000), params: { ptoken: GZP } } as any);
    expect(gif.status).toBe(200);
    expect((await gif.json() as any).image_id).toMatch(/^[0-9a-f]{32}$/);

    const { env: e2 } = makeEnv();
    const aud = await projectImage({ env: e2, request: req(`https://x/api/p/${GZP}/image`, "audio/wav", 1000), params: { ptoken: GZP } } as any);
    expect(aud.status).toBe(200);
    expect((await aud.json() as any).image_id).toMatch(/^a[0-9a-f]{32}$/);

    const { env: e3 } = makeEnv();
    const demo = await projectImage({ env: e3, request: new Request(`https://x/api/p/${GZP}/image`, { method: "POST", headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<h1>hi</h1>") }), params: { ptoken: GZP } } as any);
    expect(demo.status).toBe(200);
    expect((await demo.json() as any).image_id).toMatch(/^d[0-9a-f]{32}$/);
  });

  test("rejects a demo referencing document.cookie with 422", async () => {
    const { env } = makeEnv();
    const r = await projectImage({ env, request: new Request(`https://x/api/p/${GZP}/image`, { method: "POST", headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<script>document.cookie</script>") }), params: { ptoken: GZP } } as any);
    expect(r.status).toBe(422);
    expect((await r.json() as any).code).toBe("demo_not_selfcontained");
  });
});

// ---- Serving: /img 404s a "d" demo id; /demo serves it with sandbox headers ----
import { onRequestGet as imgGet } from "../functions/img/[id]";
import { onRequestGet as demoGet } from "../functions/demo/[id]";

const HEX32 = "0123456789abcdef0123456789abcdef";

describe("GET /img/<id>", () => {
  test("serves an audio id (a prefix) with the stored content-type", async () => {
    const IMG: any = { async get() { return { body: "AUDIO", httpMetadata: { contentType: "audio/mpeg" } }; } };
    const r = await imgGet({ env: { IMG } as any, params: { id: "a" + HEX32 } } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
  });

  test("404s a demo id (d prefix): demos are served only by /demo", async () => {
    const IMG: any = { async get() { return { body: "SHOULD-NOT-BE-SERVED", httpMetadata: { contentType: "text/html" } }; } };
    const r = await imgGet({ env: { IMG } as any, params: { id: "d" + HEX32 } } as any);
    expect(r.status).toBe(404);
  });
});

describe("GET /demo/<id>", () => {
  test("serves a d-prefixed demo with the sandbox CSP and no allow-same-origin anywhere", async () => {
    const IMG: any = { async get() { return { body: "<h1>demo</h1>" }; } };
    const r = await demoGet({ env: { IMG } as any, params: { id: "d" + HEX32 } } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = r.headers.get("content-security-policy") || "";
    // The security boundary: a sandbox directive with allow-scripts, and CRITICALLY
    // no allow-same-origin token anywhere in the header (opaque origin).
    expect(csp).toContain("sandbox");
    expect(csp).toContain("allow-scripts");
    // No allow-same-origin anywhere in ANY response header (the invariant).
    for (const [, v] of r.headers) {
      expect(v.toLowerCase()).not.toContain("allow-same-origin");
    }
  });

  test("404s a non-demo id (an image 32-hex or a v-prefixed video)", async () => {
    const IMG: any = { async get() { return { body: "x" }; } };
    const r1 = await demoGet({ env: { IMG } as any, params: { id: HEX32 } } as any);
    expect(r1.status).toBe(404);
    const r2 = await demoGet({ env: { IMG } as any, params: { id: "v" + HEX32 } } as any);
    expect(r2.status).toBe(404);
  });

  test("404s when the object is missing", async () => {
    const IMG: any = { async get() { return null; } };
    const r = await demoGet({ env: { IMG } as any, params: { id: "d" + HEX32 } } as any);
    expect(r.status).toBe(404);
  });
});
