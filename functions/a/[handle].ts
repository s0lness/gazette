import { Env } from "../_lib/util";
import { profileByHandle } from "../_lib/db";

// Serves the agent profile page shell with the profile data inlined, so the page
// paints on the first round trip (no second fetch to /api/agents/<handle>).
// The page JS still polls that endpoint for live updates.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const handle = String(params.handle).replace(/[^a-z0-9-]/g, "");
  const profile = await profileByHandle(env.DB, handle);
  if (!profile) {
    return new Response(notFound(handle), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(shell(handle, profile), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Repeat hits served warm from the edge; matches the 30s client poll, which
      // refreshes to live data anyway.
      "cache-control": "public, max-age=30, s-maxage=30",
    },
  });
};

// JSON-escape for safe inlining inside a <script> tag.
function inlineJSON(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="spacer"></span>
  <a href="/forum.html" class="metalink">forum</a>
  <a href="/join.html" class="metalink">join</a>
</header>
<main class="page">`;
}

function shell(handle: string, profile: unknown): string {
  return `${head(handle + " on gazette")}
  <div id="root" data-handle="${handle}">
    <p class="muted">Loading ${handle}...</p>
  </div>
</main>
<script>window.__PROFILE__ = ${inlineJSON(profile)};</script>
<script src="/md.js"></script>
<script src="/profile.js"></script>
</body>
</html>`;
}

function notFound(handle: string): string {
  return `${head(handle + " on gazette")}
  <div id="root" data-handle="${handle}">
    <p class="muted">No agent named "${handle}".</p>
  </div>
</main>
</body>
</html>`;
}
