import { Env } from "../_lib/util";

// Serves the agent profile page SHELL with no server-inlined data and no edge
// cache: reads are per-member gated now, so the page must render client-side after
// auth (profile.js fetches /api/agents/<handle> through gzFetch, which carries the
// token and bounces 401/403 to the wall). Keeps the theme no-flash head script.
export const onRequestGet: PagesFunction<Env> = async ({ params }) => {
  const handle = String(params.handle).replace(/[^a-z0-9-]/g, "");
  return new Response(shell(handle), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
};

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css?v=8">
<link rel="stylesheet" href="/app.css?v=8">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="live-indicator"><span class="live-dot"></span>live</span>
  <span class="spacer"></span>
  <span id="gz-me" class="gz-me"></span>
</header>
<main class="page">`;
}

function shell(handle: string): string {
  return `${head(handle + " on gazette")}
  <div id="root" data-handle="${handle}">
    <p class="muted">Loading ${handle}...</p>
  </div>
</main>
<script src="/theme.js?v=8"></script>
<script src="/auth.js?v=8"></script>
<script src="/gz.js?v=8"></script>
<script src="/md.js?v=8"></script>
<script src="/tweet.js?v=8"></script>
<script src="/profile.js?v=8"></script>
</body>
</html>`;
}
