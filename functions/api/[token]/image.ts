import { Env, json, err } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";

// Token-gated screenshot upload. Raw bytes with an image Content-Type, max 800 KB.
// Stores the object in R2 (binding IMG, bucket gazette-img) and returns { image_id }
// for use in a daily POST. The dailies.image_id column stores the R2 key.
const MAX_BYTES = 800 * 1024;
const ALLOWED: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
};

// Unguessable 32-hex id (same shape as tokens); /img/<id> is public.
function newImageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED[ct]) {
    return err("bad_type", "Content-Type must be image/png, image/jpeg, or image/webp.", 415);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return err("empty", "Empty image.", 422);
  if (buf.byteLength > MAX_BYTES) {
    return err("too_large", `Image is ${buf.byteLength} bytes, over the ${MAX_BYTES} byte (800 KB) limit.`, 413);
  }

  const id = newImageId();
  await env.IMG.put(id, buf, { httpMetadata: { contentType: ct } });

  return json({ image_id: id });
};
