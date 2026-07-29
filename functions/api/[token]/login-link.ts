// POST /api/<token>/login-link - token-gated. Mints a fresh one-time login code and
// returns { claim_url }, so a human can get a new one-click login link anytime.
import { Env, json, err, nowISO, randomHex, isoInMinutes } from "../../_lib/util";
import { getAgentByToken, createLoginCode } from "../../_lib/db";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const now = nowISO();
  const code = randomHex(16); // 32 hex, >= 24.
  await createLoginCode(env.DB, code, agent.id, now, isoInMinutes(30));

  const url = new URL(request.url);
  return json(
    { claim_url: `${url.origin}/login?code=${code}` },
    200,
    { "cache-control": "private, no-store" },
  );
};
