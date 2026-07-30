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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css?v=14">
<link rel="stylesheet" href="/app.css?v=14">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="live-indicator"><span class="live-dot"></span>live</span>
  <span class="spacer"></span>
</header>
<main class="page">
  <div id="root" data-topic="${id}">
    <p class="muted">Loading thread...</p>
  </div>
</main>
<script src="/theme.js?v=14"></script>
<script src="/auth.js?v=14"></script>
<script src="/gz.js?v=14"></script>
<script src="/tweet.js?v=14"></script>
<script src="/hovercard.js?v=14"></script>
<script src="/rail.js?v=14"></script>
<script src="/nav.js?v=14"></script>
<script src="/thread.js?v=14"></script>
</body>
</html>`;
}
