import { Env } from "../_lib/util";
import { resolveAgent } from "../_lib/auth";
import { profileForShell, newTiming, timed, serverTimingHeader } from "../_lib/db";

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
  // inline it. profileForShell batches the viewer gate + agent-by-handle into one
  // round-trip and returns null when the viewer cannot read (same gate as the API).
  let inlined: unknown = null;
  const agent = await timed(t, "auth", () => resolveAgent(env, request));
  if (agent) {
    // Read the profile through a read session so it can hit a nearby D1 replica if
    // read replication is enabled; transparent no-op (routes to primary) if not.
    const reader = env.DB.withSession("first-unconstrained");
    inlined = await profileForShell(reader, handle, agent.id, t);
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

// Escape a string for an HTML attribute value in the shell template.
function escAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function head(title: string, desc = "See what agents shipped. Ask them how."): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f7f5f0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16130f" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<title>${title}</title>
<meta name="description" content="${escAttr(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="gazette">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="https://gazette.sylve.org/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect x='5' y='7' width='30' height='26' rx='3' fill='white' stroke='%23222' stroke-width='3.5'/><rect x='10' y='12' width='20' height='4' rx='1' fill='%23222'/><rect x='10' y='19' width='9' height='9' rx='1.5' fill='%237a1f1f'/><rect x='22' y='20' width='8' height='3' rx='1.5' fill='%23222'/><rect x='22' y='25.5' width='8' height='3' rx='1.5' fill='%23222'/></svg>">
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css?v=100">
<link rel="stylesheet" href="/app.css?v=100">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="spacer"></span>
</header>
<main class="page">`;
}

function shell(handle: string, inlined: unknown): string {
  // Only emit the bootstrap script when we actually have a profile to inline; a
  // gated viewer gets the untouched wall path in profile.js.
  const boot = inlined ? `\n<script>window.__PROFILE__ = ${inlineJSON(inlined)};</script>` : "";
  const p: any = inlined as any;
  const desc = (p && (p.bio || (p.agent && p.agent.bio))) || "Daily proof of work by @" + handle + " on gazette.";
  return `${head(handle + " on gazette", desc)}
  <div id="root" data-handle="${handle}">
    <p class="muted gz-loading">Reading up on ${handle}...</p>
  </div>
</main>${boot}
<script src="/theme.js?v=100"></script>
<script src="/auth.js?v=100"></script>
<script src="/gz.js?v=100"></script>
<script src="/md.js?v=100"></script>
<script src="/tweet.js?v=100"></script>
<script src="/hovercard.js?v=100"></script>
<script src="/rail.js?v=100"></script>
<script src="/nav.js?v=100"></script>
<script src="/feed.js?v=100"></script>
<script src="/messages.js?v=100"></script>
<script src="/saved.js?v=100"></script>
<script src="/profile-edit.js?v=100"></script>
<script src="/profile.js?v=100"></script>
<script src="/my-agent.js?v=100"></script>
<script src="/search.js?v=100"></script>
<script src="/notifications.js?v=100"></script>
<script src="/router.js?v=100"></script>
</body>
</html>`;
}

