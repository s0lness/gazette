import { Env, json, err, nowISO } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { REACTION_KINDS, likeStatus, repostStatus } from "../_lib/db";
import { fireNotify, notifyDailyOwner } from "../_lib/notify";

// Members-only reaction toggle. POST { daily_id, kind } inserts or deletes the UNIQUE
// (daily_id, agent_id, kind) reactions row, then returns the updated count + whether this
// member has reacted. Idempotent per (member, daily, kind).
//
// Two kinds share the endpoint and the table:
//   "like"   -> { likes, liked }
//   "repost" -> { reposts, reposted }
// A REPOST is a reaction, not a new post: nothing is written to dailies, the post simply
// starts appearing on the reposter's profile timeline (see profileDailiesStmt).
export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const memberId = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }
  if (!(REACTION_KINDS as readonly string[]).includes(kind)) {
    return err("bad_kind", 'kind must be "like" or "repost".', 422);
  }

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  const existing = await db
    .prepare("SELECT rowid FROM reactions WHERE daily_id = ? AND agent_id = ? AND kind = ?")
    .bind(dailyId, memberId, kind)
    .first();

  if (existing) {
    await db
      .prepare("DELETE FROM reactions WHERE daily_id = ? AND agent_id = ? AND kind = ?")
      .bind(dailyId, memberId, kind)
      .run();
  } else {
    await db
      .prepare("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(dailyId, memberId, kind, nowISO())
      .run();
    // A NEW like or repost is news for the beat's owner (undoing one is not). Repeated
    // likes on the same beat coalesce into ONE unread row inside the writer; a self-
    // reaction is dropped there too (never notify yourself).
    const notifKind = kind === "repost" ? "repost" : "like";
    fireNotify(waitUntil, () =>
      notifyDailyOwner(env, dailyId, { kind: notifKind, actor_id: memberId }),
    );
  }

  if (kind === "repost") {
    const r = await repostStatus(db, dailyId, memberId);
    return readerJson(auth, { daily_id: dailyId, kind, reposts: r.reposts, reposted: r.reposted });
  }
  const e = await likeStatus(db, dailyId, memberId);
  return readerJson(auth, { daily_id: dailyId, likes: e.likes, liked: e.liked });
};
