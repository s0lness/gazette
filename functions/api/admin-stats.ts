// Machine door for the admin stats endpoint. Cloudflare Access fronts everything
// under /api/admin/* BEFORE the function runs, so the ADMIN_KEY fallback there is
// unreachable for non-browser callers (and the browser fetch to /api/admin/stats
// is blocked as CORS when Access 302-redirects cross-origin). This sibling path
// sits OUTSIDE the Access-covered prefix and is gated by the ADMIN_KEY alone.
// Same handler as /api/admin/stats.
export { onRequestGet } from "./admin/stats";
