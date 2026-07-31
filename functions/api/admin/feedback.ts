import { Env, json, nowISO, isoInDays } from "../../_lib/util";

// Admin feedback surface. Same gate as /api/admin/stats: behind Cloudflare Access
// (Cf-Access-Jwt-Assertion, injected only after the allow policy passed at the edge)
// OR the admin key (header or ?key=). Read-only reads never cached.
//
// GET  -> { ok, feedback: [{id, handle, source, body, created_at, read_at}] } newest
//         first, LIMIT 200, joined to agents for the handle (null agent -> null handle),
//         plus question_recap_network: the top 10 agents by oracle questions received in
//         the last 7 days ([{handle, project, count_7d}]), so the digest can surface what
//         the whole network keeps being asked. POST { ids: [...] } -> marks read_at = now.

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

  // Network question recap: which agents' oracles fielded the most questions this week.
  // The project asked ABOUT is encoded in visitor_hash's ":p<id>" suffix (as elsewhere),
  // so we pull the last 7 days of dm_log with the answering agent's handle, aggregate per
  // agent in JS (count + the most-asked project id), then resolve those project names.
  const dmRs = await env.DB
    .prepare(
      `SELECT d.agent_id AS agent_id, a.handle AS handle, d.visitor_hash AS visitor_hash
       FROM dm_log d JOIN agents a ON a.id = d.agent_id
       WHERE d.created_at >= ?`,
    )
    .bind(isoInDays(-7))
    .all<{ agent_id: number; handle: string; visitor_hash: string }>();

  const projectIdOf = (visitorHash: string): number | null => {
    const m = /:p(\d+)$/.exec(visitorHash);
    return m ? Number(m[1]) : null;
  };
  const perAgent = new Map<number, { handle: string; count_7d: number; projectCounts: Map<number, number> }>();
  for (const r of dmRs.results ?? []) {
    let g = perAgent.get(r.agent_id);
    if (!g) {
      g = { handle: r.handle, count_7d: 0, projectCounts: new Map() };
      perAgent.set(r.agent_id, g);
    }
    g.count_7d += 1;
    const pid = projectIdOf(r.visitor_hash);
    if (pid !== null) g.projectCounts.set(pid, (g.projectCounts.get(pid) ?? 0) + 1);
  }
  const topAgents = [...perAgent.values()]
    .filter((g) => g.count_7d > 0)
    .sort((a, b) => b.count_7d - a.count_7d)
    .slice(0, 10);
  // The dominant project id per top agent (most-asked), for a name lookup.
  const dominantPid = (g: { projectCounts: Map<number, number> }): number | null => {
    let best: number | null = null;
    let bestN = 0;
    for (const [pid, n] of g.projectCounts) if (n > bestN) { best = pid; bestN = n; }
    return best;
  };
  const pids = [...new Set(topAgents.map(dominantPid).filter((x): x is number => x !== null))];
  const projectById = new Map<number, string>();
  if (pids.length > 0) {
    const projRs = await env.DB
      .prepare(`SELECT id, name FROM projects WHERE id IN (${pids.map(() => "?").join(",")})`)
      .bind(...pids)
      .all<{ id: number; name: string }>();
    for (const p of projRs.results ?? []) projectById.set(p.id, p.name);
  }
  const question_recap_network = topAgents.map((g) => {
    const pid = dominantPid(g);
    return { handle: g.handle, project: pid !== null ? projectById.get(pid) ?? null : null, count_7d: g.count_7d };
  });

  return json({ ok: true, feedback, question_recap_network }, 200, NO_STORE);
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
