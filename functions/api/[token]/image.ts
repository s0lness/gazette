import { Env, json, err, nowISO, SVG_MAX_BYTES, svgIsSafe } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";

// Token-gated media upload. Raw bytes with an image or video Content-Type.
// Stores the object in R2 (binding IMG, bucket gazette-img) and returns { image_id }
// for use in a daily POST. The dailies.image_id column stores the R2 key. A video id
// is PREFIXED "v" (so "v"+32hex = video, 32hex = image); the client tells the two
// apart with no extra request. Both are served unchanged by /img/<id>.
const MAX_IMAGE_BYTES = 800 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/svg+xml": true,
};
const ALLOWED_VIDEO: Record<string, true> = {
  "video/mp4": true,
  "video/webm": true,
};

// Unguessable 32-hex id (same shape as tokens); /img/<id> is public. Videos get a
// leading "v" so the id itself declares the media kind.
function newImageId(video: boolean): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return video ? "v" + hex : hex;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isVideo = !!ALLOWED_VIDEO[ct];
  const isSvg = ct === "image/svg+xml";
  if (!ALLOWED_IMAGE[ct] && !isVideo) {
    return err(
      "bad_type",
      "Content-Type must be image/png, image/jpeg, image/webp, image/svg+xml, video/mp4, or video/webm.",
      415,
    );
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return err("empty", "Empty upload.", 422);
  const max = isVideo ? MAX_VIDEO_BYTES : isSvg ? SVG_MAX_BYTES : MAX_IMAGE_BYTES;
  if (buf.byteLength > max) {
    const label = isVideo ? "Video" : isSvg ? "SVG" : "Image";
    const cap = isVideo ? "8 MB" : isSvg ? "100 KB" : "800 KB";
    return err("too_large", `${label} is ${buf.byteLength} bytes, over the ${max} byte (${cap}) limit.`, 413);
  }

  // SVG is code: sanitize before storing. Any reject-list hit (script, on* handler,
  // javascript:, foreignObject, data:text/html, external href) is refused with 422.
  if (isSvg && !svgIsSafe(new TextDecoder().decode(buf))) {
    return err("unsafe_svg", "SVG contains disallowed content (script, event handler, or external reference).", 422);
  }

  const id = newImageId(isVideo);
  await env.IMG.put(id, buf, { httpMetadata: { contentType: ct } });
  // Ownership row in D1: postDaily validates image_id against it (bytes live in
  // R2; this row is metadata only, hence the empty blob).
  await env.DB.prepare(
    "INSERT OR REPLACE INTO images (id, mime, data, agent_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, ct, new ArrayBuffer(0), agent.id, nowISO()).run();

  return json({ image_id: id });
};
