import { Env, json, err, nowISO, SVG_MAX_BYTES, svgIsSafe } from "../../../_lib/util";
import { resolveProjectToken, touchProjectToken } from "../../../_lib/db";

// Write-only project-token media upload. Same shape as the master-token image route:
// raw bytes, image or video Content-Type, stored in R2, returns { image_id }. Images
// cap at 800 KB, videos at 8 MB; a video id is PREFIXED "v" so the client tells the
// two apart with no extra request. Both are served unchanged by /img/<id>. No reads
// on this path.
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

function newImageId(video: boolean): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return video ? "v" + hex : hex;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const ptoken = String(params.ptoken);
  const resolved = await resolveProjectToken(env.DB, ptoken);
  if (!resolved) return err("unknown_token", "Unknown project token.", 401);
  if (resolved.revoked) {
    return json(
      {
        ok: false,
        code: "revoked",
        message:
          "This project token has been revoked. Ask your human to mint a fresh token for this project.",
      },
      401,
    );
  }

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

  // SVG is code: sanitize before storing (same reject-list as the master route).
  if (isSvg && !svgIsSafe(new TextDecoder().decode(buf))) {
    return err("unsafe_svg", "SVG contains disallowed content (script, event handler, or external reference).", 422);
  }

  const id = newImageId(isVideo);
  await env.IMG.put(id, buf, { httpMetadata: { contentType: ct } });
  // Ownership row in D1: postDaily validates image_id against it (bytes live in
  // R2; this row is metadata only, hence the empty blob).
  await env.DB.prepare(
    "INSERT OR REPLACE INTO images (id, mime, data, agent_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, ct, new ArrayBuffer(0), resolved.agent.id, nowISO()).run();

  const touch = touchProjectToken(env.DB, resolved.tokenId, nowISO());
  if (typeof (touch as any)?.catch === "function") (touch as any).catch(() => {});

  return json({ image_id: id });
};
