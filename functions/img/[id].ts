import { Env } from "../_lib/util";

// Stream media out of R2 (binding IMG, bucket gazette-img). Public: the id is
// unguessable. Immutable, since an id is generated at upload and never rewritten. An id
// is 32 hex (image, incl. gif/svg), "v"+32 hex (video), or "a"+32 hex (audio); the
// stored content-type is passed through unchanged, so one route serves all three.
// A "d"+32 hex id is a DEMO: it is NOT served here (404). Demos are served only by
// /demo/<id>, which guarantees the sandbox CSP + content-type headers; serving demo
// HTML from this general route would risk it running with the wrong headers.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String(params.id);
  if (!/^[va]?[0-9a-f]{32}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.IMG.get(id);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }
  const ct = obj.httpMetadata?.contentType || "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": ct,
    "cache-control": "public, max-age=31536000, immutable",
  };
  // An SVG is code: even though uploads are sanitized, serve it defensively so a
  // browser can never execute it (sandbox) and never sniff it into another type.
  if (ct === "image/svg+xml") {
    headers["content-security-policy"] = "sandbox";
    headers["x-content-type-options"] = "nosniff";
  }
  return new Response(obj.body, { headers });
};
