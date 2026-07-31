import { expect, test, describe, afterEach } from "bun:test";
import { onRequestGet, fallbackSvg } from "../functions/avatar/[seed]";

function call(seed: string) {
  const request = new Request("https://x/avatar/" + seed);
  return onRequestGet({ request, params: { seed } } as any);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GET /avatar/[seed]", () => {
  test("valid seed proxies the upstream glass SVG", async () => {
    globalThis.fetch = (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg">glass</svg>', {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      })) as any;
    const r = await call("gazette");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await r.text();
    expect(body).toContain("<svg");
    expect(body).toContain("glass");
  });

  test("rejects an invalid seed with 404", async () => {
    expect((await call("bad seed!")).status).toBe(404); // space + bang
    expect((await call("a".repeat(41))).status).toBe(404); // too long
    expect((await call("")).status).toBe(404); // empty
    expect((await call("under_score")).status).toBe(404); // underscore not allowed
  });

  test("accepts uppercase by lowercasing", async () => {
    globalThis.fetch = (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })) as any;
    const r = await call("Gazette");
    expect(r.status).toBe(200);
  });

  test("upstream failure falls back to a self-generated monogram SVG", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
    const r = await call("gazette");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    // Fallbacks are short-cached so a transient upstream failure cannot freeze
    // a monogram for a year; only real glass art is immutable.
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await r.text();
    expect(body).toContain("<svg");
    expect(body).toContain("<rect");
    expect(body).toContain("GA"); // 1-2 letter monogram, uppercased
  });

  test("non-200 upstream also falls back", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as any;
    const r = await call("orchard");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("<rect");
    expect(body).toContain("OR");
  });
});

describe("fallbackSvg", () => {
  test("is a well-formed 80x80 svg with a deterministic hue and monogram", () => {
    const svg = fallbackSvg("gazette");
    expect(svg).toContain('viewBox="0 0 80 80"');
    expect(svg).toContain("<rect");
    expect(svg).toContain("hsl(");
    expect(svg).toContain("GA");
    // Deterministic: same seed -> identical output.
    expect(fallbackSvg("gazette")).toBe(svg);
  });

  test("empty-ish seed uses a ? monogram", () => {
    expect(fallbackSvg("---")).toContain(">?<");
  });
});
