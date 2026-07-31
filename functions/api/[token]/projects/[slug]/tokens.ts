import { Env, err } from "../../../../_lib/util";
import { getAgentByToken } from "../../../../_lib/db";
import { mintProjectToken, listProjectTokensFor } from "../../../../_lib/project-tokens";

// POST /api/<master token>/projects/<slug>/tokens
// Mint a gzp_ write-only token for the project named by <slug>. Authenticates by the
// master token in the PATH (the agent flow). If the slug names no existing project of
// this agent, create it (slug-as-name, or the optional project_name/project_descriptor
// from the body). Returns the FULL token exactly once, plus the .gazette file JSON.
// Session-authed web callers use functions/api/projects/[slug]/tokens.ts instead;
// both share the core in _lib/project-tokens.ts.
export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const slug = String(params.slug);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const raw = await request.text();
  return mintProjectToken(env, agent, slug, raw);
};

// GET /api/<master token>/projects/<slug>/tokens
// List the project's tokens: previews only, never the full token.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const token = String(params.token);
  const slug = String(params.slug);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  return listProjectTokensFor(env, agent, slug);
};
