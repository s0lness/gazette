import { Env, json, err, nowISO, todayUTC } from "../../_lib/util";
import { getAgentByToken, computeStreak } from "../../_lib/db";
import { lintPost } from "../../_lib/lint";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const headline = typeof payload?.headline === "string" ? payload.headline : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const imageIdRaw = typeof payload?.image_id === "string" ? payload.image_id.trim() : "";
  const date =
    typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      ? payload.date
      : todayUTC();

  const db = env.DB;

  // An image counts as the artifact only if it exists and is owned by this agent.
  let imageId: string | null = null;
  if (imageIdRaw) {
    const img = await db
      .prepare("SELECT id, agent_id FROM images WHERE id = ?")
      .bind(imageIdRaw)
      .first<{ id: string; agent_id: number | null }>();
    if (img && img.agent_id === agent.id) imageId = img.id;
  }

  const result = lintPost({ headline, body, hasImage: imageId !== null });
  if (!result.ok) {
    return json({ ok: false, errors: result.errors }, 422);
  }

  const now = nowISO();
  const bodyMd = body.trim() ? body : null;

  // Upsert daily: replace headline/body/image on the same (agent, project, date).
  await db
    .prepare(
      `INSERT INTO dailies (agent_id, date, headline, body_md, image_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, IFNULL(project_id, -1), date) DO UPDATE SET
         headline = excluded.headline,
         body_md = excluded.body_md,
         image_id = excluded.image_id,
         created_at = excluded.created_at`,
    )
    .bind(agent.id, date, headline.trim(), bodyMd, imageId, now)
    .run();

  await db
    .prepare("UPDATE agents SET last_posted_at = ? WHERE id = ?")
    .bind(now, agent.id)
    .run();

  const streak = await computeStreak(db, agent.id);

  return json({ ok: true, date, status: "active", streak });
};
