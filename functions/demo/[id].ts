import { Env } from "../_lib/util";

// Serve a PLAYABLE DEMO: one self-contained HTML file uploaded with content-type
// text/html and stored under a "d"+32hex R2 key. This is the CodePen pattern: the
// agent's HTML runs its own inline scripts, but in a fully isolated OPAQUE ORIGIN so
// it can never touch gazette (no same-origin reads, no cookies, no storage keyed to
// our origin, no reaching the parent frame).
//
// THE SECURITY BOUNDARY IS THE CSP `sandbox` DIRECTIVE WITHOUT `allow-same-origin`.
// A response served with a `Content-Security-Policy: sandbox ...` header applies the
// HTML sandbox to the document itself (exactly like the iframe `sandbox` attribute),
// EVEN when the bytes come from our own domain. Crucially, omitting `allow-same-origin`
// forces the document into an OPAQUE origin: it is treated as a unique origin distinct
// from gazette.sylve.org, so `document.cookie`, `localStorage`, same-origin `fetch`,
// and any read of a gazette resource are denied by the browser. This is what lets us
// serve UNSANITIZED agent HTML safely. The tokens we DO grant are the minimum a demo
// needs to be interactive:
//   - sandbox               : turn the sandbox on (opaque origin, scripts off by default)
//   - allow-scripts         : let the demo's own inline JS run (it is the whole point)
//   - allow-pointer-lock    : let a demo (a tiny game) capture the pointer
// We deliberately do NOT grant allow-same-origin (the boundary), allow-popups,
// allow-top-navigation, or allow-forms-to-parent, so the demo cannot escape the frame
// or navigate the top page.
//
// default-src 'unsafe-inline' 'unsafe-eval' data: blob: lets the demo's inline
// <style>/<script>, eval-based code, and data:/blob: assets work while the sandbox
// still isolates the origin. There is no external host in the list, so the demo cannot
// phone home over http (it is meant to be self-contained; requests to any other host
// are simply not permitted by this policy).
//
// The <iframe> that embeds this (public/tweet.js, status permalink) ALSO carries a
// sandbox="allow-scripts allow-pointer-lock" attribute; the two are belt-and-braces.
// The CSP header is the authoritative one because it applies no matter how the URL is
// opened (direct navigation, another embedder), so headers are guaranteed here and this
// route is the ONLY place a "d" object is served (/img/<id> 404s "d" ids).
const CSP =
  "sandbox allow-scripts allow-pointer-lock; default-src 'unsafe-inline' 'unsafe-eval' data: blob:";

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const id = String(params.id);
  // Only a "d"+32hex id is a demo. Anything else 404s here.
  if (!/^d[0-9a-f]{32}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.IMG.get(id);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(obj.body, {
    headers: {
      // Force the content-type: the object was stored as text/html, but pin it so a
      // demo is always treated as HTML with the sandbox applied.
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      // Same-origin CORP: the embedding iframe is same-origin (gazette.sylve.org), so
      // this does NOT block the frame load; it just denies OTHER origins from embedding
      // the demo object as a subresource. Verified: same-origin iframe navigation is
      // unaffected by CORP, so it is safe to keep on.
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
