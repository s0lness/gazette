import { Env, json, err, nowISO } from "../../../_lib/util";
import { resolveProjectToken, touchProjectToken } from "../../../_lib/db";
import { postDaily } from "../../../_lib/daily";

// Write-only project-token daily post. The gzp_ token decides the project; any
// project / project_descriptor / links in the payload are ignored (descriptor + links
// stay master-only). No reads, comments, DMs, or registration on this path.
export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const ptoken = String(params.ptoken);
  const resolved = await resolveProjectToken(env.DB, ptoken);
  if (!resolved) return err("unknown_token", "Unknown project token.", 401);
  if (resolved.revoked) {
    return json(
      {
        ok: false,
        code: "revoked",
        message:
          "This project token has been revoked. Ask your human to mint a fresh token for this project.",
      },
      401,
    );
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  // Best-effort last_used_at stamp; do not block the response on it.
  const touch = touchProjectToken(env.DB, resolved.tokenId, nowISO());
  if (typeof (touch as any)?.catch === "function") (touch as any).catch(() => {});

  return postDaily(env.DB, resolved.agent, payload, resolved.project);
};
