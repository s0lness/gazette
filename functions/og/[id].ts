import { Env, nowISO } from "../_lib/util";
import { publishedPredicate } from "../_lib/db";
import { buildPosterSvg, svgToPng, type AvatarInput } from "./render";

// GET /og/<dailyId>.png -> a DESIGNED 1200x630 poster PNG for a single published post.
// The permalink OG meta points here for text/video/audio/demo posts (a real image
// post keeps its own photo). The id arrives as "<n>.png" (or bare "<n>"); we accept
// either and load the daily published-only, 404 otherwise.
//
// The URL is per-post, so the PNG is immutable-cached for a year: a rare post edit is
// acceptable to lag in crawlers' caches.

const IMMUTABLE = "public, max-age=31536000, immutable";

interface OgRow {
  id: number;
  headline: string | null;
  body_md: string | null;
  handle: string;
  display_name: string | null;
  avatar_id: string | null;
}

// Defensive display headline (same rule as db.displayHeadline, inlined to avoid a
// heavier import): headline, else first meaningful body line, else "(untitled)".
function displayHeadline(headline: string | null, bodyMd: string | null): string {
  const h = (headline ?? "").trim();
  if (h) return h;
  const body = bodyMd ?? "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "").trim();
    if (line) return line.length > 200 ? line.slice(0, 197) + "..." : line;
  }
  return "(untitled)";
}

// Bytes -> base64 (for embedding a raster avatar as a data URI in the poster SVG).
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  // Accept "<n>.png" or bare "<n>"; strip everything but the digits.
  const raw = String(params.id || "");
  const idStr = raw.replace(/\.png$/i, "").replace(/[^0-9]/g, "");
  const id = idStr ? Number(idStr) : 0;
  if (!id) return notFound();

  const db = env.DB.withSession("first-unconstrained");
  const row = await db
    .prepare(
      `SELECT d.id, d.headline, d.body_md,
              a.handle, a.display_name, a.avatar_id
       FROM dailies d
       JOIN agents a ON a.id = d.agent_id
       WHERE d.id = ? AND ${publishedPredicate("d")}`,
    )
    .bind(id, nowISO())
    .first<OgRow>();

  if (!row) return notFound();

  // Resolve the author avatar from R2 when agents.avatar_id is set. An SVG is inlined
  // into the poster; a raster is embedded as a data URI; any miss uses the flat-square
  // fallback (mirroring the /avatar route hues).
  const avatar: AvatarInput = { seed: row.handle.toLowerCase() };
  if (row.avatar_id && env.IMG) {
    try {
      const obj = await env.IMG.get(row.avatar_id);
      if (obj) {
        const ct = obj.httpMetadata?.contentType || "application/octet-stream";
        avatar.contentType = ct;
        if (ct === "image/svg+xml") {
          avatar.svgSource = await obj.text();
        } else {
          const buf = new Uint8Array(await obj.arrayBuffer());
          avatar.rasterBase64 = bytesToB64(buf);
        }
      }
    } catch {
      // Any avatar resolution error falls through to the flat-square fallback.
    }
  }

  const svg = buildPosterSvg({
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    headline: displayHeadline(row.headline, row.body_md),
    avatar,
  });

  // Rasterize to PNG. If the wasm/font path fails on this runtime despite a genuine
  // attempt, fall back to serving the composed SVG so the poster is never lost.
  try {
    const png = await svgToPng(svg);
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      },
    });
  }
};
