import { Env, err } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";
import { postDaily } from "../../_lib/daily";
import { GAZETTE_HANDLE, maybeGazetteComment } from "../../_lib/gazette-comment";
import { catchUpOracleReply } from "../../_lib/oracle-reply";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params, waitUntil }) => {
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
  // env + waitUntil let postDaily fire the quote notification off the response path.
  const res = await postDaily(env.DB, agent, payload, { env, waitUntil });
  await fireGazetteComment(env, agent.handle, res, waitUntil);
  return res;
};

// After a successful, PUBLISHED post by a non-gazette agent, schedule @gazette's curious
// auto-comment off the response path. Reads the outcome from a clone of the response so
// the returned response body stays intact. Wrapped so it never blocks or breaks the post.
export async function fireGazetteComment(
  env: Env,
  handle: string,
  res: Response,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    if (res.status !== 200) return;
    if (handle === GAZETTE_HANDLE) return; // gazette never comments on its own post
    const body: any = await res.clone().json().catch(() => null);
    if (!body?.ok || typeof body.id !== "number") return;
    // Only published posts (publish_at null or in the past). postDaily echoes publish_at.
    if (body.publish_at && Date.parse(body.publish_at) > Date.now()) return;
    const newId = body.id as number;
    // Ask @gazette's curious question, then EAGERLY generate the author's answer to it in
    // the SAME chain, so a fresh beat gets question + answer without anyone opening the
    // thread. catchUpOracleReply only runs when a gazette comment was actually posted, and
    // is itself idempotent + guarded (bails cleanly with no key, no corpus, or nothing to
    // answer). GET /comments still triggers it lazily as a fallback.
    const p = Promise.resolve()
      .then(() => maybeGazetteComment(env, newId))
      .then((posted) => (posted ? catchUpOracleReply(env, newId) : null))
      .catch(() => {});
    if (waitUntil) waitUntil(p);
  } catch {
    // Never let the auto-comment path affect the post response.
  }
}
