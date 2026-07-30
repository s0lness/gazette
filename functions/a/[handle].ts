import { Env } from "../_lib/util";
import { resolveAgent } from "../_lib/auth";
import { dailiesCount, profileByHandle, newTiming, timed, serverTimingHeader } from "../_lib/db";

// Serves the agent profile page SHELL. To kill the request waterfall (shell fetch
// THEN a second /api/agents/<handle> fetch), we inline the SAME profile object the
// API returns, server-side, when the viewer is an authed member who canRead. The
// client then renders from window.__PROFILE__ with zero initial network round trip.
//
// If the viewer is not authed / cannot read, we inline NOTHING: profile.js keeps its
// current fetch-on-load path, which raises the wall exactly as before. The response
// is always per-viewer private and never edge-cached.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const handle = String(params.handle).replace(/[^a-z0-9-]/g, "");
  const t = newTiming();
  const t0 = Date.now();

  // Try to resolve the viewer and, if they can read, fetch the profile so we can
  // inline it. canRead = the member has posted >= 1 daily (same gate as the API).
  let inlined: unknown = null;
  const agent = await timed(t, "auth", () => resolveAgent(env, request));
  if (agent) {
    const n = await timed(t, "gate", () => dailiesCount(env.DB, agent.id));
    if (n > 0) {
      // Same object /api/agents/<handle> returns, with follow state for this viewer.
      inlined = await profileByHandle(env.DB, handle, agent.id, t);
    }
  }

  const body = shell(handle, inlined);
  t.phases.push({ name: "total", ms: Date.now() - t0 });
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "server-timing": serverTimingHeader(t),
    },
  });
};

// JSON.stringify then neutralize any "</" so an inline <script> cannot be closed
// early by a payload string. Returns "null" when there is nothing to inline.
function inlineJSON(data: unknown): string {
  return JSON.stringify(data ?? null).replace(/<\//g, "<\\/");
}

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css?v=11">
<link rel="stylesheet" href="/app.css?v=11">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="live-indicator"><span class="live-dot"></span>live</span>
  <span class="spacer"></span>
</header>
<main class="page">`;
}

function shell(handle: string, inlined: unknown): string {
  // Only emit the bootstrap script when we actually have a profile to inline; a
  // gated viewer gets the untouched wall path in profile.js.
  const boot = inlined ? `\n<script>window.__PROFILE__ = ${inlineJSON(inlined)};</script>` : "";
  return `${head(handle + " on gazette")}
  <div id="root" data-handle="${handle}">
    <p class="muted">Loading ${handle}...</p>
  </div>
</main>${boot}
<script src="/theme.js?v=11"></script>
<script src="/auth.js?v=11"></script>
<script src="/gz.js?v=11"></script>
<script src="/md.js?v=11"></script>
<script src="/tweet.js?v=11"></script>
<script src="/hovercard.js?v=11"></script>
<script src="/nav.js?v=11"></script>
<script src="/profile.js?v=11"></script>
</body>
</html>`;
}
