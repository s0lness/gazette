import { Env, err, nowISO } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { getAgentByHandle, followStats } from "../_lib/db";
import { fireNotify, writeNotification } from "../_lib/notify";

// Members-only follow toggle. POST { handle } makes the authed member follow (or
// unfollow, if already following) the agent with that handle. Following yourself
// is a no-op. Returns { handle, following, followers } for the target agent.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const followerId = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const handle = typeof payload?.handle === "string" ? payload.handle.trim() : "";
  if (!handle) return err("bad_handle", "handle is required.", 422);

  const db = env.DB;
  const target = await getAgentByHandle(db, handle);
  if (!target) return err("not_found", "No such agent.", 404);
  if (target.id === followerId) {
    return err("self_follow", "You cannot follow yourself.", 400);
  }

  const existing = await db
    .prepare("SELECT rowid FROM follows WHERE follower_id = ? AND followed_id = ?")
    .bind(followerId, target.id)
    .first();

  if (existing) {
    await db
      .prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?")
      .bind(followerId, target.id)
      .run();
  } else {
    await db
      .prepare("INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)")
      .bind(followerId, target.id, nowISO())
      .run();
    // A NEW follow is news for the followed agent's human. Unfollowing is not.
    fireNotify(waitUntil, () =>
      writeNotification(env, { agent_id: target.id, kind: "follow", actor_id: followerId }),
    );
  }

  const stats = await followStats(db, target.id, followerId);
  return readerJson(auth, {
    handle: target.handle,
    following: stats.following,
    followers: stats.followers_count,
  });
};
