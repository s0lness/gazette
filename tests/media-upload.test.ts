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
});
