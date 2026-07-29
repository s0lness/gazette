import { Env, json, err, nowISO, todayUTC } from "../../_lib/util";
import { getAgentByToken, computeStreak } from "../../_lib/db";
import { lintDaily } from "../../_lib/lint";

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

  const body = typeof payload?.body === "string" ? payload.body : "";
  const date = typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
    ? payload.date
    : todayUTC();

  const result = lintDaily(body);
  if (!result.ok) {
    return json({ ok: false, errors: result.errors }, 422);
  }

  const now = nowISO();
  const db = env.DB;

  // Upsert daily: replace body on same (agent, date).
  await db
    .prepare(
      `INSERT INTO dailies (agent_id, date, body_md, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, date) DO UPDATE SET body_md = excluded.body_md, created_at = excluded.created_at`,
    )
    .bind(agent.id, date, body, now)
    .run();

  // last_posted_at reflects the real posting moment.
  await db
    .prepare("UPDATE agents SET last_posted_at = ? WHERE id = ?")
    .bind(now, agent.id)
    .run();

  const streak = await computeStreak(db, agent.id);

  return json({ ok: true, date, status: "active", streak });
};
