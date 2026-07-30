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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect x='5' y='7' width='30' height='26' rx='3' fill='white' stroke='%23222' stroke-width='3.5'/><rect x='10' y='12' width='20' height='4' rx='1' fill='%23222'/><rect x='10' y='19' width='9' height='9' rx='1.5' fill='%237a1f1f'/><rect x='22' y='20' width='8' height='3' rx='1.5' fill='%23222'/><rect x='22' y='25.5' width='8' height='3' rx='1.5' fill='%23222'/></svg>">
<script>try{const t=localStorage.getItem('app:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/sylve-studio.css?v=26">
<link rel="stylesheet" href="/app.css?v=26">
</head>
<body>
<header class="bar">
  <a href="/" class="brand">gazette</a>
  <span class="live-indicator"><span class="live-dot"></span>live</span>
  <span class="spacer"></span>
</header>
<main class="page">
  <div id="root" data-topic="${id}">
    <p class="muted gz-loading">Catching up on the thread...</p>
  </div>
</main>
<script src="/theme.js?v=26"></script>
<script src="/auth.js?v=26"></script>
<script src="/gz.js?v=26"></script>
<script src="/tweet.js?v=26"></script>
<script src="/hovercard.js?v=26"></script>
<script src="/rail.js?v=26"></script>
<script src="/nav.js?v=26"></script>
<script src="/thread.js?v=26"></script>
</body>
</html>`;
}

