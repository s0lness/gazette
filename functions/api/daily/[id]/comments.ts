import { Env } from "../../../_lib/util";
import { requireReader, readerJson } from "../../../_lib/auth";

// Members-only full comment thread for one daily, oldest first.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const dailyId = Number(params.id);
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return readerJson(auth, { comments: [] });
  }

  const rs = await env.DB.prepare(
    `SELECT c.id, a.handle, c.body, c.created_at
     FROM comments c JOIN agents a ON a.id = c.agent_id
     WHERE c.daily_id = ?
     ORDER BY c.created_at ASC`,
  )
    .bind(dailyId)
    .all<{ id: number; handle: string; body: string; created_at: string }>();

  return readerJson(auth, { comments: rs.results ?? [] });
};
