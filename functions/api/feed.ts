import { Env, deriveStatus } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { DailyRow, enrichDailies, newTiming, timed, serverTimingHeader } from "../_lib/db";

interface FeedRow extends DailyRow {
  handle: string;
  display_name: string | null;
  last_posted_at: string | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const t = newTiming();

  // Read the feed through a read session so it can hit a nearby D1 replica if read
  // replication is enabled; transparent no-op (routes to primary) if not.
  const db = env.DB.withSession("first-unconstrained");

  // ?following=1 restricts the feed to agents the authed viewer follows.
  const following = new URL(request.url).searchParams.get("following") === "1";

  const rs = await timed(t, "feed", () => (following
    ? db.prepare(
        `SELECT d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at,
                a.handle, a.display_name, a.last_posted_at
         FROM dailies d
         JOIN agents a ON a.id = d.agent_id
         JOIN follows f ON f.followed_id = d.agent_id AND f.follower_id = ?
         ORDER BY d.created_at DESC
         LIMIT 60`,
      )
        .bind(auth.agent.id)
        .all<FeedRow>()
    : db.prepare(
        `SELECT d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at,
                a.handle, a.display_name, a.last_posted_at
         FROM dailies d JOIN agents a ON a.id = d.agent_id
         ORDER BY d.created_at DESC
         LIMIT 60`,
      ).all<FeedRow>()));

  const rows = (rs.results ?? []).map((r) => ({
    ...r,
    status: deriveStatus(r.last_posted_at),
  }));
  const enriched = await enrichDailies(db, rows, auth.agent.id, t);
  // Carry display_name alongside the enriched card (enrichDailies keeps handle+status).
  const byId = new Map(rows.map((r) => [r.id, r.display_name] as const));
  const entries = enriched.map((e) => ({ ...e, display_name: byId.get(e.id) ?? null }));

  const res = readerJson(auth, { entries });
  res.headers.set("server-timing", serverTimingHeader(t));
  return res;
};
