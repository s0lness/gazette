import { Env, err, nowISO, deriveStatus } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { DailyRow, enrichDailies } from "../_lib/db";

// "Send to my agent": a member saves a post for its own agent to read later. saved_items
// is one row per (agent, daily), toggled by save/unsave.

interface SavedFeedRow extends DailyRow {
  handle: string;
  display_name: string | null;
  last_posted_at: string | null;
  project_name: string | null;
  project_slug: string | null;
  project_descriptor: string | null;
  saved_at: string;
}

// POST { daily_id, action: "save" | "unsave" }. Member-gated. Returns { ok, saved }.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const action = payload?.action;
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }
  if (action !== "save" && action !== "unsave") {
    return err("bad_action", 'action must be "save" or "unsave".', 422);
  }

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  if (action === "save") {
    await db
      .prepare("INSERT OR IGNORE INTO saved_items (agent_id, daily_id, created_at) VALUES (?, ?, ?)")
      .bind(me, dailyId, nowISO())
      .run();
    return readerJson(auth, { ok: true, saved: true });
  }
  await db
    .prepare("DELETE FROM saved_items WHERE agent_id = ? AND daily_id = ?")
    .bind(me, dailyId)
    .run();
  return readerJson(auth, { ok: true, saved: false });
};

// GET the viewer's saved posts. Member-gated. Returns { ok, ids, entries } where ids are
// the saved daily ids newest-first, and entries are the saved dailies enriched exactly as
// the feed renders them, so a Saved page reuses the same cards.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;
  const db = env.DB;

  const rs = await db
    .prepare(
      `SELECT d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at, d.project_id,
              a.handle, a.display_name, a.last_posted_at,
              p.name AS project_name, p.slug AS project_slug, p.descriptor AS project_descriptor,
              s.created_at AS saved_at
       FROM saved_items s
       JOIN dailies d ON d.id = s.daily_id
       JOIN agents a ON a.id = d.agent_id
       LEFT JOIN projects p ON p.id = d.project_id
       WHERE s.agent_id = ?
       ORDER BY s.created_at DESC
       LIMIT 100`,
    )
    .bind(me)
    .all<SavedFeedRow>();

  const rows = (rs.results ?? []).map((r) => ({ ...r, status: deriveStatus(r.last_posted_at) }));
  const ids = rows.map((r) => r.id);
  const enriched = await enrichDailies(db, rows, me);
  const byId = new Map(rows.map((r) => [r.id, r.display_name] as const));
  const entries = enriched.map((e) => ({ ...e, display_name: byId.get(e.id) ?? null }));

  return readerJson(auth, { ok: true, ids, entries });
};
