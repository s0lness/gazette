import { Env, json, err, nowISO, SVG_MAX_BYTES, svgIsSafe } from "../../../_lib/util";
import { resolveProjectToken, touchProjectToken } from "../../../_lib/db";

// Write-only project-token media upload. Same shape as the master-token image route:
// raw bytes, a media Content-Type, stored in R2, returns { image_id }. The id declares
// the media KIND via a leading prefix: 32hex = image (png/jpeg/webp/svg/gif),
// "v"+32hex = video (mp4/webm), "a"+32hex = audio (mp3/ogg/wav), "d"+32hex = a
// self-contained HTML demo. Images/videos/audio serve from /img/<id>; a demo ("d")
// serves ONLY from /demo/<id>. No reads on this path.
const MAX_IMAGE_BYTES = 800 * 1024;
const MAX_GIF_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_DEMO_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/svg+xml": true,
  "image/gif": true,
};
const ALLOWED_VIDEO: Record<string, true> = {
  "video/mp4": true,
  "video/webm": true,
};
const ALLOWED_AUDIO: Record<string, true> = {
  "audio/mpeg": true,
  "audio/ogg": true,
  "audio/wav": true,
};
// A playable demo: one self-contained HTML file. It executes ONLY inside an
// opaque-origin sandbox (served by /demo/<id>), so the stored HTML is NOT sanitized.
// The tripwires are a courtesy 422 for the obviously-broken; real security is the sandbox.
const ALLOWED_DEMO: Record<string, true> = { "text/html": true };
const DEMO_PARENT_REFS: RegExp[] = [/window\.parent/i, /window\.top/i, /document\.cookie/i];

// Media-kind prefix declares the kind: "v" video, "a" audio, "d" demo; none = image.
function newImageId(prefix: "" | "v" | "a" | "d"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
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
  const isAudio = !!ALLOWED_AUDIO[ct];
  const isDemo = !!ALLOWED_DEMO[ct];
  const isSvg = ct === "image/svg+xml";
  const isGif = ct === "image/gif";
  if (!ALLOWED_IMAGE[ct] && !isVideo && !isAudio && !isDemo) {
    return err(
      "bad_type",
      "Content-Type must be an image (png, jpeg, webp, svg, gif), video (mp4, webm), audio (mpeg, ogg, wav), or text/html demo.",
      415,
    );
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return err("empty", "Empty upload.", 422);
  // Per-type size cap: demo 2 MB, gif 4 MB, video/audio 8 MB, svg 100 KB, other images 800 KB.
  const max = isDemo
    ? MAX_DEMO_BYTES
    : isVideo
    ? MAX_VIDEO_BYTES
    : isAudio
    ? MAX_AUDIO_BYTES
    : isGif
    ? MAX_GIF_BYTES
    : isSvg
    ? SVG_MAX_BYTES
    : MAX_IMAGE_BYTES;
  if (buf.byteLength > max) {
    const label = isDemo ? "Demo" : isVideo ? "Video" : isAudio ? "Audio" : isGif ? "GIF" : isSvg ? "SVG" : "Image";
    const cap = isDemo ? "2 MB" : isVideo ? "8 MB" : isAudio ? "8 MB" : isGif ? "4 MB" : isSvg ? "100 KB" : "800 KB";
    return err("too_large", `${label} is ${buf.byteLength} bytes, over the ${max} byte (${cap}) limit.`, 413);
  }

  // SVG is code: sanitize before storing (same reject-list as the master route).
  if (isSvg && !svgIsSafe(new TextDecoder().decode(buf))) {
    return err("unsafe_svg", "SVG contains disallowed content (script, event handler, or external reference).", 422);
  }

  // Demo HTML is NOT sanitized (opaque-origin sandbox at /demo/<id>). Courtesy tripwire:
  // reject the obviously-broken that reaches for the parent frame; sandbox is the boundary.
  if (isDemo && DEMO_PARENT_REFS.some((re) => re.test(new TextDecoder().decode(buf)))) {
    return err(
      "demo_not_selfcontained",
      "Demo references the parent page (window.parent, window.top, or document.cookie). A demo must be self-contained; it runs sandboxed with no access to gazette.",
      422,
    );
  }

  const id = newImageId(isVideo ? "v" : isAudio ? "a" : isDemo ? "d" : "");
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
