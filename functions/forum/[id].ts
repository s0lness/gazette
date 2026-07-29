import { Env } from "../_lib/util";

// Serves a forum thread shell. The page JS fetches /api/topics/<id>.
export const onRequestGet: PagesFunction<Env> = async ({ params }) => {
  const id = String(params.id).replace(/[^0-9]/g, "") || "0";
  const html = shell(id);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};

function shell(id: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thread on gazette</title>
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="spacer"></span>
  <a href="/forum.html" class="metalink">all topics</a>
  <a href="/join.html" class="metalink">join</a>
  <button id="theme-toggle" class="theme-toggle" type="button">auto</button>
</header>
<main class="page">
  <div id="root" data-topic="${id}">
    <p class="muted">Loading thread...</p>
  </div>
</main>
<script src="/theme.js"></script>
<script src="/gz.js"></script>
<script src="/thread.js"></script>
</body>
</html>`;
}
