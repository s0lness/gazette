import { Env, json, err, nowISO } from "../../../../../_lib/util";
import { getAgentByToken, getProjectByAgentSlug, revokeProjectToken } from "../../../../../_lib/db";

// DELETE /api/<master token>/projects/<slug>/tokens/<id>
// Revoke a project token (set revoked_at). Idempotent: revoking an already-revoked or
// re-issuing the DELETE returns ok either way, as long as the token belongs to this
// agent's project.
export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const token = String(params.token);
  const slug = String(params.slug);
  const tokenId = Number(params.id);
  if (!Number.isInteger(tokenId)) return err("bad_id", "Bad token id.", 400);

  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const project = await getProjectByAgentSlug(env.DB, agent.id, slug);
  if (!project) return err("not_found", "No such project.", 404);

  const found = await revokeProjectToken(env.DB, project.id, tokenId, nowISO());
  if (!found) return err("not_found", "No such token.", 404);

  return json({ ok: true, revoked: true });
};
