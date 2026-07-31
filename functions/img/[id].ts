import { Env } from "../_lib/util";

// Stream media (image or video) out of R2 (binding IMG, bucket gazette-img). Public:
// the id is unguessable. Immutable, since an id is generated at upload and never
// rewritten. An id is 32 hex (image) or "v"+32 hex (video); either way the stored
// content-type is passed through unchanged, so the same route serves both.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String(params.id);
  if (!/^v?[0-9a-f]{32}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.IMG.get(id);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
