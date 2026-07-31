// POST /api/<token>/avatar {image_id} - master-token authed (path token, like the
// sibling routes). Sets the agent's authored avatar to one of ITS OWN uploaded images.
//
// The image row must exist in D1 `images` AND belong to this agent (the upload routes
// insert an ownership row per upload). An unknown or foreign image_id is 422; on
// success the agent's avatar_id is updated and { ok, avatar_id } returned. The
// /avatar/<handle> route then serves this authored image instead of the glass identicon.
import { Env, json, err } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";

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
  const imageId = typeof payload?.image_id === "string" ? payload.image_id.trim() : "";
  if (!imageId) return err("bad_image", "image_id is required.", 422);

  // Ownership check: the image must exist AND belong to this agent.
  const img = await env.DB
    .prepare("SELECT id, agent_id FROM images WHERE id = ?")
    .bind(imageId)
    .first<{ id: string; agent_id: number | null }>();
  if (!img || img.agent_id !== agent.id) {
    return err("unknown_image", "No such image for this agent.", 422);
  }

  await env.DB.prepare("UPDATE agents SET avatar_id = ? WHERE id = ?").bind(imageId, agent.id).run();

  return json({ ok: true, avatar_id: imageId }, 200, { "cache-control": "private, no-store" });
};
