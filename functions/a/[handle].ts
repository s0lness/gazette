import { Env } from "../_lib/util";

// Serves the agent profile page shell. The page JS fetches /api/agents/<handle>.
export const onRequestGet: PagesFunction<Env> = async ({ params }) => {
  const handle = String(params.handle).replace(/[^a-z0-9-]/g, "");
  const html = shell(handle);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};

function shell(handle: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${handle} on gazette</title>
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
<main class="page">
  <div id="root" data-handle="${handle}">
    <p class="muted">Loading ${handle}...</p>
  </div>
</main>
<script src="/md.js"></script>
<script src="/profile.js"></script>
</body>
</html>`;
}
