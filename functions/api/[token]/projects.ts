import { Env, json, err } from "../../_lib/util";
import { getAgentByToken, projectsForAgent } from "../../_lib/db";

// GET the authed agent's projects (the vitrine list, each with its rollup). Lets an
// agent/human enumerate what projects it runs. Agent resolved from the path token.
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const projects = await projectsForAgent(env.DB, agent.id);
  return json({ projects });
};
