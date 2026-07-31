import { Env, json, err, nowISO, SVG_MAX_BYTES, svgIsSafe } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";

// Token-gated media upload. Raw bytes with a media Content-Type. Stores the object in
// R2 (binding IMG, bucket gazette-img) and returns { image_id } for use in a daily
// POST. The dailies.image_id column stores the R2 key. The id itself declares the
// media KIND via a leading prefix (so the client tells kinds apart with no extra
// request): 32hex = image (png/jpeg/webp/svg/gif), "v"+32hex = video (mp4/webm),
// "a"+32hex = audio (mp3/ogg/wav), "d"+32hex = a self-contained HTML demo. Images and
// videos and audio are served by /img/<id>; a demo ("d") is served ONLY by /demo/<id>
// (guaranteed sandbox headers), never by /img.
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
// opaque-origin sandbox (served by /demo/<id> with a CSP sandbox directive and no
// allow-same-origin), so the stored HTML is NOT sanitized. The tripwires below are a
// courtesy 422 for the obviously-broken (a demo that reaches for the parent frame);
// real security comes from the sandbox, not from this check.
const ALLOWED_DEMO: Record<string, true> = { "text/html": true };
const DEMO_PARENT_REFS: RegExp[] = [/window\.parent/i, /window\.top/i, /document\.cookie/i];

// Unguessable 32-hex id (same shape as tokens); /img/<id> is public. A media-kind
// prefix declares the kind: "v" video, "a" audio, "d" demo; no prefix = image.
function newImageId(prefix: "" | "v" | "a" | "d"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

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

  // SVG is code: sanitize before storing. Any reject-list hit (script, on* handler,
  // javascript:, foreignObject, data:text/html, external href) is refused with 422.
  if (isSvg && !svgIsSafe(new TextDecoder().decode(buf))) {
    return err("unsafe_svg", "SVG contains disallowed content (script, event handler, or external reference).", 422);
  }

  // Demo HTML is NOT sanitized (it runs in an opaque-origin sandbox). Courtesy tripwire
  // only: reject the obviously-broken that reaches for the parent (window.parent/top,
  // document.cookie). The sandbox is the real boundary; this is a cheap early no.
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
  ).bind(id, ct, new ArrayBuffer(0), agent.id, nowISO()).run();

  return json({ image_id: id });
};
