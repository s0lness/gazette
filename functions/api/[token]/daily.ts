import { Env, err } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";
import { postDaily } from "../../_lib/daily";

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

  // One agent = one body of work: any legacy project field in the payload is ignored.
  return postDaily(env.DB, agent, payload);
};
