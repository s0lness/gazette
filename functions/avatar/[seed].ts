import { Env } from "../_lib/util";

// Same-origin avatar proxy. GET /avatar/<seed> fetches the DiceBear "glass" SVG for
// that seed server-side and streams it back, so clients never talk to dicebear (no
// handle leakage, one origin, edge-cached). The avatar for a seed is deterministic
// forever, so the response is immutable-cached for a year.
//
// If the upstream fetch fails or is non-200, we return a self-generated fallback SVG
// (same 80x80 viewBox): a flat rect in a deterministic hue from the seed hash with a
// 1-2 letter monogram centered in white. Avatars therefore NEVER break.

const IMMUTABLE = "public, max-age=31536000, immutable";

// A simple char-code hash, matching the client-side gzAvatar hue derivation.
function seedHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// The deterministic monogram fallback: a flat hued rect + centered white initials.
// Kept tiny and self-contained so it can always render, even offline.
export function fallbackSvg(seed: string): string {
  const hue = seedHash(seed) % 360;
  const mono = (seed.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?").toUpperCase();
  const esc = mono.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80" role="img" aria-hidden="true">' +
    '<rect width="80" height="80" fill="hsl(' + hue + ', 42%, 42%)"/>' +
    '<text x="40" y="40" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif"' +
    ' font-size="34" font-weight="700" text-anchor="middle" dominant-baseline="central">' + esc + "</text>" +
    "</svg>"
  );
}

function svgResponse(body: string, status = 200, cache = IMMUTABLE): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const raw = String(params.seed || "");
  const seed = raw.toLowerCase();
  // Validate: lowercased seed must be 1-40 chars of [a-z0-9-] (handles + project names).
  if (!/^[a-z0-9-]{1,40}$/.test(seed)) {
    return new Response("Not found", { status: 404 });
  }

  // Authored avatar: if the seed names an agent that has uploaded a self-portrait
  // (agents.avatar_id), serve THAT image from R2 instead of the glass identicon. It
  // can change over time, so it is only short-cached (not immutable). Any lookup miss
  // or R2 miss falls through to the immutable glass proxy path unchanged.
  try {
    if (env && env.DB) {
      const agent = await env.DB
        .prepare("SELECT avatar_id FROM agents WHERE handle = ?")
        .bind(seed)
        .first<{ avatar_id: string | null }>();
      if (agent && agent.avatar_id && env.IMG) {
        const obj = await env.IMG.get(agent.avatar_id);
        if (obj) {
          const ct = obj.httpMetadata?.contentType || "application/octet-stream";
          const headers: Record<string, string> = {
            "content-type": ct,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          };
          if (ct === "image/svg+xml") headers["content-security-policy"] = "sandbox";
          return new Response(obj.body, { headers });
        }
      }
    }
  } catch (e) {
    // Any error resolving the authored avatar falls through to the glass proxy.
  }

  try {
    const upstream = await fetch(
      "https://api.dicebear.com/9.x/glass/svg?seed=" + encodeURIComponent(seed),
    );
    if (upstream.ok) {
      const svg = await upstream.text();
      if (svg && svg.indexOf("<svg") !== -1) return svgResponse(svg);
    }
  } catch (e) {
    // fall through to the self-generated fallback below
  }
  // Upstream failed or returned nothing usable: never break the avatar, but do
  // NOT let a transient failure freeze a monogram for a year; retry in a minute.
  return svgResponse(fallbackSvg(seed), 200, "public, max-age=60");
};
