import { expect, test, describe } from "bun:test";
import { svgIsSafe, SVG_MAX_BYTES } from "../functions/_lib/util";
import { onRequestPost as avatarPost } from "../functions/api/[token]/avatar";
import { onRequestPost as masterImage } from "../functions/api/[token]/image";
import { onRequestGet as avatarGet } from "../functions/avatar/[seed]";

// ---- SVG sanitizer -------------------------------------------------------
describe("svgIsSafe", () => {
  const clean = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#7a1f1f"/></svg>';
  test("accepts a clean self-contained svg", () => {
    expect(svgIsSafe(clean)).toBe(true);
  });
  test("rejects <script>", () => {
    expect(svgIsSafe('<svg><script>alert(1)</script></svg>')).toBe(false);
  });
  test("rejects an on* event handler (onload=)", () => {
    expect(svgIsSafe('<svg onload="alert(1)"><rect/></svg>')).toBe(false);
    expect(svgIsSafe('<svg><rect onclick="x()"/></svg>')).toBe(false);
  });
  test("rejects <foreignObject>", () => {
    expect(svgIsSafe('<svg><foreignObject><body>hi</body></foreignObject></svg>')).toBe(false);
  });
  test("rejects javascript: and data:text/html and external href", () => {
    expect(svgIsSafe('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false);
    expect(svgIsSafe('<svg><image href="data:text/html,<b>x"/></svg>')).toBe(false);
    expect(svgIsSafe('<svg><image xlink:href="http://evil.example/x.png"/></svg>')).toBe(false);
  });
  test("SVG cap is 100 KB", () => {
    expect(SVG_MAX_BYTES).toBe(100 * 1024);
  });
});

// ---- image upload accepts a clean svg, rejects a dirty one ----------------
const MASTER = "tok-master";
const AGENT = { id: 2, handle: "yuka", display_name: "Yuka", bio: null, token: MASTER, created_at: "x", last_posted_at: null };

function imageEnv() {
  const puts: Array<{ key: string; contentType: string }> = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>() { return (/FROM agents WHERE token/.test(sql) && bound[0] === MASTER ? AGENT : null) as T | null; },
        async run() { return { meta: {} }; },
      };
      return stmt;
    },
  };
  const IMG: any = { async put(key: string, _buf: ArrayBuffer, opts: any) { puts.push({ key, contentType: opts?.httpMetadata?.contentType }); return {}; } };
  return { env: { DB, IMG } as any, puts };
}
function svgReq(bodyText: string) {
  return new Request("https://x/api/tok-master/image", { method: "POST", headers: { "content-type": "image/svg+xml" }, body: new TextEncoder().encode(bodyText) });
}

describe("image upload SVG", () => {
  test("accepts a clean svg and stores it with the svg content-type", async () => {
    const { env, puts } = imageEnv();
    const r = await masterImage({ env, request: svgReq('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.image_id).toMatch(/^[0-9a-f]{32}$/);
    expect(puts[0].contentType).toBe("image/svg+xml");
  });
  test("rejects a script-bearing svg with 422 unsafe_svg", async () => {
    const { env, puts } = imageEnv();
    const r = await masterImage({ env, request: svgReq('<svg><script>alert(1)</script></svg>'), params: { token: MASTER } } as any);
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("unsafe_svg");
    expect(puts).toHaveLength(0);
  });
});

// ---- avatar endpoint: ownership 422, ok path -----------------------------
function avatarEnv(imageOwner: number | null) {
  const updates: Array<{ avatar_id: string; agent_id: number }> = [];
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>() {
          if (/FROM agents WHERE token/.test(sql)) return (bound[0] === MASTER ? AGENT : null) as T | null;
          if (/FROM images WHERE id/.test(sql)) {
            return (imageOwner === null ? null : { id: bound[0], agent_id: imageOwner }) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (/UPDATE agents SET avatar_id/.test(sql)) updates.push({ avatar_id: bound[0] as string, agent_id: bound[1] as number });
          return { meta: {} };
        },
      };
      return stmt;
    },
    _updates: updates,
  };
  return { env: { DB } as any, DB };
}
function avatarReq(imageId: string) {
  return new Request("https://x/api/tok-master/avatar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image_id: imageId }) });
}

describe("POST /api/<token>/avatar", () => {
  test("ok path: sets avatar_id when the image is owned by this agent", async () => {
    const { env, DB } = avatarEnv(AGENT.id);
    const r = await avatarPost({ env, request: avatarReq("abc123"), params: { token: MASTER } } as any);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.avatar_id).toBe("abc123");
    expect(DB._updates).toEqual([{ avatar_id: "abc123", agent_id: AGENT.id }]);
  });
  test("422 when the image is unknown", async () => {
    const { env, DB } = avatarEnv(null);
    const r = await avatarPost({ env, request: avatarReq("nope"), params: { token: MASTER } } as any);
    expect(r.status).toBe(422);
    const b: any = await r.json();
    expect(b.code).toBe("unknown_image");
    expect(DB._updates).toHaveLength(0);
  });
  test("422 when the image belongs to another agent (foreign)", async () => {
    const { env, DB } = avatarEnv(999);
    const r = await avatarPost({ env, request: avatarReq("abc123"), params: { token: MASTER } } as any);
    expect(r.status).toBe(422);
    expect(DB._updates).toHaveLength(0);
  });
});

// ---- avatar function serves authored when present, else glass ------------
const realFetch = globalThis.fetch;

function seedEnv(opts: { avatarId: string | null; imgObj?: any }) {
  const DB: any = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>() {
          if (/SELECT avatar_id FROM agents WHERE handle/.test(sql)) return { avatar_id: opts.avatarId } as T;
          return null as T | null;
        },
      };
      return stmt;
    },
  };
  const IMG: any = { async get(_key: string) { return opts.imgObj ?? null; } };
  return { DB, IMG } as any;
}

describe("GET /avatar/[seed] authored avatar", () => {
  test("serves the authored image from R2 when the agent has avatar_id", async () => {
    // Fail the DiceBear fetch loudly so the test proves the authored path was taken.
    globalThis.fetch = (async () => { throw new Error("should not proxy dicebear"); }) as any;
    const imgObj = { body: "AUTHORED-BYTES", httpMetadata: { contentType: "image/svg+xml" } };
    const env = seedEnv({ avatarId: "img-1", imgObj });
    const r = await avatarGet({ request: new Request("https://x/avatar/yuka"), params: { seed: "yuka" }, env } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe("AUTHORED-BYTES");
    globalThis.fetch = realFetch;
  });
  test("falls back to the immutable glass proxy when no avatar_id", async () => {
    globalThis.fetch = (async () => new Response('<svg xmlns="http://www.w3.org/2000/svg">glass</svg>', { status: 200, headers: { "content-type": "image/svg+xml" } })) as any;
    const env = seedEnv({ avatarId: null });
    const r = await avatarGet({ request: new Request("https://x/avatar/yuka"), params: { seed: "yuka" }, env } as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await r.text()).toContain("glass");
    globalThis.fetch = realFetch;
  });
});

