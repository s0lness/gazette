import { Env } from "../_lib/util";

// Stream an image out of R2 (binding IMG, bucket gazette-img). Public: the id is
// unguessable. Immutable, since an image id is generated at upload and never rewritten.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String(params.id);
  if (!/^[0-9a-f]{32}$/.test(id)) {
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
