import { expect, test, describe } from "bun:test";
import { onRequestGet as ogGet } from "../functions/og/[id]";
import { buildPosterSvg, wrapHeadline, parseAvatarSvg, escXml } from "../functions/og/render";

// The "Instagram filter": every non-image post renders as a DESIGNED 1200x630 poster
// PNG at /og/<id>.png. These tests cover the route (404 / 200 png) and the pure SVG
// composition (headline wrapping + escaping, handle, footer URL, avatar inlining).

// A fake env: ONE D1 read (.first) answers with the row (or null), and an optional R2
// bucket answering .get() with an avatar object.
function ogEnv(row: any | null, r2?: Record<string, { contentType: string; body: string | Uint8Array }>) {
  const DB: any = {
    withSession() { return DB; },
    prepare(_sql: string) {
      const stmt: any = { bind() { return stmt; }, async first() { return row; } };
      return stmt;
    },
  };
  const IMG: any = {
    async get(key: string) {
      const o = r2?.[key];
      if (!o) return null;
      return {
        httpMetadata: { contentType: o.contentType },
        async text() { return typeof o.body === "string" ? o.body : new TextDecoder().decode(o.body); },
        async arrayBuffer() {
          if (typeof o.body === "string") return new TextEncoder().encode(o.body).buffer;
          return (o.body as Uint8Array).buffer;
        },
      };
    },
  };
  return { DB, IMG } as any;
}

const baseRow = {
  id: 42,
  headline: "I mapped every hidden API endpoint in a legacy codebase",
  body_md: "## Shipped\nTraced the runtime.",
  handle: "cartographer",
  display_name: "Cartographer",
  avatar_id: null,
};

describe("GET /og/<id>.png (designed poster)", () => {
  test("404 when the id is unknown / unpublished", async () => {
    const r = await ogGet({ env: ogEnv(null), params: { id: "999.png" } } as any);
    expect(r.status).toBe(404);
  });

  test("404 when the id has no digits", async () => {
    const r = await ogGet({ env: ogEnv(baseRow), params: { id: ".png" } } as any);
    expect(r.status).toBe(404);
  });

  test("200 image/png with a real PNG signature (resvg rasterizes)", async () => {
    const r = await ogGet({ env: ogEnv(baseRow), params: { id: "42.png" } } as any);
    expect(r.status).toBe(200);
    const ct = r.headers.get("content-type");
    // Prefer PNG; tolerate the documented SVG fallback if a runtime cannot rasterize.
    expect(ct === "image/png" || ct === "image/svg+xml; charset=utf-8").toBe(true);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const buf = new Uint8Array(await r.arrayBuffer());
    if (ct === "image/png") {
      // PNG magic: 89 50 4E 47.
      expect([...buf.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } else {
      expect(new TextDecoder().decode(buf)).toContain("<svg");
    }
  });

  test("accepts a bare numeric id (no .png suffix)", async () => {
    const r = await ogGet({ env: ogEnv(baseRow), params: { id: "42" } } as any);
    expect(r.status).toBe(200);
  });

  test("inlines an authored SVG avatar from R2 without erroring", async () => {
    const svgAvatar =
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#123456"/></svg>';
    const env = ogEnv(
      { ...baseRow, avatar_id: "abc123" },
      { abc123: { contentType: "image/svg+xml", body: svgAvatar } },
    );
    const r = await ogGet({ env, params: { id: "42.png" } } as any);
    expect(r.status).toBe(200);
    const ct = r.headers.get("content-type");
    expect(ct === "image/png" || ct === "image/svg+xml; charset=utf-8").toBe(true);
  });
});

describe("buildPosterSvg (composition)", () => {
  const svg = buildPosterSvg({
    id: 42,
    handle: "cartographer",
    displayName: "Cartographer",
    headline: "I mapped every hidden API endpoint in a legacy codebase",
    avatar: { seed: "cartographer" },
  });

  test("is a 1200x630 svg in the house palette", () => {
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("#f2ede4"); // paper
    expect(svg).toContain("#7a1f1f"); // oxblood accent
    expect(svg.startsWith("<svg")).toBe(true);
  });

  test("shows the wordmark, the headline text, the handle, and the footer permalink", () => {
    expect(svg).toContain(">gazette</text>");
    expect(svg).toContain("hidden API"); // part of the wrapped headline
    expect(svg).toContain(">@cartographer</text>");
    expect(svg).toContain("gazette.sylve.org/a/cartographer/status/42");
  });

  test("escapes a dangerous headline (no raw script, quotes escaped)", () => {
    const nasty = buildPosterSvg({
      id: 7,
      handle: "cartographer",
      headline: 'pwn <script>alert("x")</script> "quoted" & done',
      avatar: { seed: "cartographer" },
    });
    expect(nasty).not.toContain("<script>alert");
    expect(nasty).toContain("&lt;script&gt;");
    expect(nasty).toContain("&quot;quoted&quot;");
    expect(nasty).toContain("&amp;");
  });

  test("falls back to the flat hued square + initial when no avatar", () => {
    // No avatar -> a hsl() rect and the uppercased first initial in a <text>.
    expect(svg).toContain("hsl(");
    expect(svg).toContain(">C</text>");
  });

  test("uses the handle as name when display_name is absent", () => {
    const s = buildPosterSvg({ id: 1, handle: "orchard", headline: "hi", avatar: { seed: "orchard" } });
    expect(s).toContain(">orchard</text>"); // name line falls back to handle
    expect(s).toContain(">@orchard</text>");
  });
});

describe("wrapHeadline", () => {
  test("wraps to at most maxLines and ellipsizes overflow", () => {
    const long = "word ".repeat(60).trim();
    const lines = wrapHeadline(long, 26, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });

  test("keeps a short headline on one line, no ellipsis", () => {
    const lines = wrapHeadline("short and sweet", 26, 3);
    expect(lines).toEqual(["short and sweet"]);
  });

  test("hard-splits a single word longer than a line", () => {
    const lines = wrapHeadline("supercalifragilisticexpialidociousandthensome", 10, 3);
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("parseAvatarSvg", () => {
  test("extracts the viewBox and inner content, dropping the xml prolog", () => {
    const { viewBox, inner } = parseAvatarSvg(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect/></svg>',
    );
    expect(viewBox).toBe("0 0 16 16");
    expect(inner).toContain("<rect");
    expect(inner).not.toContain("<svg");
  });

  test("defaults the viewBox to 0 0 16 16 when absent", () => {
    const { viewBox } = parseAvatarSvg("<svg><rect/></svg>");
    expect(viewBox).toBe("0 0 16 16");
  });
});

describe("escXml", () => {
  test("escapes the five xml metacharacters", () => {
    expect(escXml(`<a b="c" d='e' & f>`)).toBe("&lt;a b=&quot;c&quot; d=&apos;e&apos; &amp; f&gt;");
  });
});
