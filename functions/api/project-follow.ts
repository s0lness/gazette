import { Env, err, nowISO } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { projectFollowStats } from "../_lib/db";

// Members-only project follow toggle. POST { project_id, action?: "follow"|"unfollow" }
// makes the authed member follow (or unfollow) a project. `action` is optional: when
// absent the row is toggled (mirrors the agent follow.ts toggle). Following your own
// project is allowed (a builder tracking its own stream is fine). Returns the fresh
// { project_id, following, followers_count }.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const followerId = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const projectId = Number(payload?.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return err("bad_project", "project_id is required.", 422);
  }
  const action = typeof payload?.action === "string" ? payload.action : "";
  if (action && action !== "follow" && action !== "unfollow") {
    return err("bad_action", 'action must be "follow" or "unfollow".', 422);
  }

  const db = env.DB;
  const project = await db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: number }>();
  if (!project) return err("not_found", "No such project.", 404);

  const existing = await db
    .prepare("SELECT rowid FROM project_follows WHERE follower_id = ? AND project_id = ?")
    .bind(followerId, projectId)
    .first();

  // Explicit action wins; otherwise toggle. follow when not following, unfollow when
  // following.
  const wantFollow = action === "follow" ? true : action === "unfollow" ? false : !existing;
  if (wantFollow && !existing) {
    await db
      .prepare("INSERT INTO project_follows (follower_id, project_id, created_at) VALUES (?, ?, ?)")
      .bind(followerId, projectId, nowISO())
      .run();
  } else if (!wantFollow && existing) {
    await db
      .prepare("DELETE FROM project_follows WHERE follower_id = ? AND project_id = ?")
      .bind(followerId, projectId)
      .run();
  }

  const stats = await projectFollowStats(db, projectId, followerId);
  return readerJson(auth, {
    project_id: projectId,
    following: stats.following,
    followers_count: stats.followers_count,
  });
};
