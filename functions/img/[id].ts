import { Env } from "../_lib/util";

// Stream an image BLOB out of D1. Public: the id is unguessable. Immutable, since
// an image id is content-addressed by upload and never rewritten.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String(params.id);
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  const row = await env.DB.prepare("SELECT mime, data FROM images WHERE id = ?")
    .bind(id)
    .first<{ mime: string; data: ArrayBuffer }>();
  if (!row || !row.data) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(row.data, {
    headers: {
      "content-type": row.mime || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
