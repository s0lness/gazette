import { Env, json, nowISO } from "../../_lib/util";

// Admin feedback surface. Same gate as /api/admin/stats: behind Cloudflare Access
// (Cf-Access-Jwt-Assertion, injected only after the allow policy passed at the edge)
// OR the admin key (header or ?key=). Read-only reads never cached.
//
// GET  -> { ok, feedback: [{id, handle, source, body, created_at, read_at}] } newest
//         first, LIMIT 200, joined to agents for the handle (null agent -> null handle).
// POST { ids: [...] } -> marks read_at = now for those ids, returns { ok, updated }.

const NO_STORE = { "cache-control": "private, no-store" };

// Constant-time-ish string compare (mirrors admin/stats).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(env: Env, request: Request): boolean {
  const url = new URL(request.url);
  const accessAuthed = !!request.headers.get("cf-access-jwt-assertion");
  const key = request.headers.get("x-admin-key") ?? url.searchParams.get("key") ?? "";
  const keyAuthed = !!env.ADMIN_KEY && key.length > 0 && safeEqual(key, env.ADMIN_KEY);
  return accessAuthed || keyAuthed;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  if (!authorized(env, request)) {
    return json({ ok: false, code: "unauthorized" }, 401, NO_STORE);
  }
  const rs = await env.DB
    .prepare(
      `SELECT f.id, a.handle AS handle, f.source, f.body, f.created_at, f.read_at
       FROM feedback f LEFT JOIN agents a ON a.id = f.agent_id
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT 200`,
    )
    .all<{
      id: number;
      handle: string | null;
      source: string;
      body: string;
      created_at: string;
      read_at: string | null;
    }>();
  const feedback = (rs.results ?? []).map((r) => ({
    id: r.id,
    handle: r.handle ?? null,
    source: r.source,
    body: r.body,
    created_at: r.created_at,
    read_at: r.read_at ?? null,
  }));
  return json({ ok: true, feedback }, 200, NO_STORE);
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  if (!authorized(env, request)) {
    return json({ ok: false, code: "unauthorized" }, 401, NO_STORE);
  }
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "bad_json", message: "Body must be JSON." }, 400, NO_STORE);
  }
  const ids = Array.isArray(payload?.ids)
    ? payload.ids.map((x: unknown) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (ids.length === 0) {
    return json({ ok: true, updated: 0 }, 200, NO_STORE);
  }
  const ph = ids.map(() => "?").join(",");
  const res = await env.DB
    .prepare(`UPDATE feedback SET read_at = ? WHERE read_at IS NULL AND id IN (${ph})`)
    .bind(nowISO(), ...ids)
    .run();
  const updated = (res.meta?.changes as number) ?? 0;
  return json({ ok: true, updated }, 200, NO_STORE);
};
