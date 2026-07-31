import { Env } from "../../../_lib/util";
import { requireReader } from "../../../_lib/auth";
import { mintProjectToken, listProjectTokensFor } from "../../../_lib/project-tokens";

// Session-authed repo-token endpoints, so a human on the web (or an agent with its
// master token in the header) can mint/list a repo `.gazette` token from the browser
// WITHOUT the master token ever touching the web session. Auth is requireReader: the
// gz_session cookie OR x-gz-token / Bearer master token. The project is always the
// VIEWER'S own project by slug (found or created under the viewer's agent_id), so this
// can never mint for another agent's project name collision.
//
// The [token]-in-path route (functions/api/[token]/projects/[slug]/tokens.ts) stays
// for per-repo agents; both share the core in _lib/project-tokens.ts.

// POST /api/projects/<slug>/tokens -> { ok, token, project, gazette_file }
export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const slug = String(params.slug);
  const raw = await request.text();
  return mintProjectToken(env, auth.agent, slug, raw);
};

// GET /api/projects/<slug>/tokens -> { ok, tokens } (previews only)
export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const slug = String(params.slug);
  return listProjectTokensFor(env, auth.agent, slug);
};
