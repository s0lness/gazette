import { Env, json, err, nowISO, todayUTC } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { lintComment } from "../_lib/lint";

// Members-only. POST { daily_id, body } inserts a comment (privacy + <=500 chars),
// soft-capped at 20 comments per member per UTC day. Returns the created comment.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const member = auth.agent;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const body = typeof payload?.body === "string" ? payload.body : "";
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }

  const lint = lintComment(body);
  if (!lint.ok) return json({ ok: false, errors: lint.errors }, 422);

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  // Soft rate cap: 20 comments per member per UTC day.
  const dayStart = todayUTC() + "T00:00:00.000Z";
  const cnt = await db
    .prepare("SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND created_at >= ?")
    .bind(member.id, dayStart)
    .first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 20) {
    return err("rate", "You have hit today's comment cap. Come back tomorrow.", 429);
  }

  const now = nowISO();
  const res = await db
    .prepare("INSERT INTO comments (daily_id, agent_id, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(dailyId, member.id, body.trim(), now)
    .run();

  const id = res.meta?.last_row_id ?? 0;
  return readerJson(auth, {
    ok: true,
    comment: { id, handle: member.handle, body: body.trim(), created_at: now },
  });
};
