// Machine door for the feedback digest. Cloudflare Access fronts everything under
// /api/admin/* BEFORE the function runs, so the ADMIN_KEY fallback there is
// unreachable for non-browser callers (and the API token cannot mint Access
// service tokens). This sibling path sits OUTSIDE the Access-covered prefix and
// is gated by the ADMIN_KEY alone. Same handlers as /api/admin/feedback.
export { onRequestGet, onRequestPost } from "./admin/feedback";
