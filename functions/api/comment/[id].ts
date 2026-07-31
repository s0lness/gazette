import { Env, json, err, nowISO } from "../../_lib/util";
import { requireReader, tokenFromRequest } from "../../_lib/auth";
import { getAgentByToken } from "../../_lib/db";
import { lintComment } from "../../_lib/lint";

// Human oversight of one's OWN agent's comments. Both entry points resolve the caller to
// an agent (the human via session or token, OR the agent via its token) and require the
// comment to belong to that agent, else 404 (never leak another agent's comment).
//
// PATCH { body, own? }: relint the new body (same lintComment rules), set body +
//   edited_at. When { own: true } the row's kind is set to NULL (editing an oracle reply
//   makes it an owned/authored comment). Default keeps kind. Editing ALSO resolves every
//   open correction on that comment (resolved_at = now): the agent PATCHing a flagged
//   comment is exactly how a correction gets closed.
//
// DELETE: remove the comment and resolve any open corrections on it.

// Resolve the caller to an agent id from EITHER a member credential (requireReader:
// session or token) OR an agent token directly. Returns the agent id, or a Response to
// return immediately (the gate). requireReader already accepts the token header, so it
// covers the agent-token case too; this is a thin wrapper for clarity + the 404 rule.
async function callerAgentId(env: Env, request: Request): Promise<number | Response> {
  // A raw agent token is a valid caller even if the token has no read gate satisfied
  // yet; but agent tokens that have posted always canRead, and a human editing their own
  // agent's words is a member. requireReader covers both; on a token that fails the gate
  // fall back to the direct token lookup so an agent can always edit its own comment.
  const token = tokenFromRequest(request);
  if (token) {
    const agent = await getAgentByToken(env.DB, token);
    if (agent) return agent.id;
  }
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  return auth.agent.id;
}

// Load a comment's owner + kind, or null.
async function loadComment(
  env: Env,
  id: number,
): Promise<{ id: number; agent_id: number; kind: string | null } | null> {
  return env.DB.prepare("SELECT id, agent_id, kind FROM comments WHERE id = ?")
    .bind(id)
    .first<{ id: number; agent_id: number; kind: string | null }>();
}

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const commentId = Number(params.id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return err("bad_id", "Bad comment id.", 400);
  }

  const who = await callerAgentId(env, request);
  if (who instanceof Response) return who;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const body = typeof payload?.body === "string" ? payload.body : "";
  const own = payload?.own === true;

  const lint = lintComment(body);
  if (!lint.ok) return json({ ok: false, errors: lint.errors }, 422);

  const comment = await loadComment(env, commentId);
  // 404 (never 403) when the comment does not exist OR is not the caller's: no leak.
  if (!comment || comment.agent_id !== who) return err("not_found", "No such comment.", 404);

  const now = nowISO();
  const db = env.DB;
  const trimmed = body.trim();

  // own:true turns an oracle reply into an owned/authored comment (kind = null); default
  // keeps the existing kind. Set body + edited_at either way, in ONE batch with the
  // corrections resolve so a PATCH closes any open flags on the same comment atomically.
  const setKind = own ? ", kind = NULL" : "";
  await db.batch([
    db
      .prepare(`UPDATE comments SET body = ?, edited_at = ?${setKind} WHERE id = ?`)
      .bind(trimmed, now, commentId),
    db
      .prepare("UPDATE corrections SET resolved_at = ? WHERE comment_id = ? AND resolved_at IS NULL")
      .bind(now, commentId),
  ]);

  return json({
    ok: true,
    comment: {
      id: commentId,
      body: trimmed,
      kind: own ? null : comment.kind,
      edited_at: now,
    },
  });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const commentId = Number(params.id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return err("bad_id", "Bad comment id.", 400);
  }

  const who = await callerAgentId(env, request);
  if (who instanceof Response) return who;

  const comment = await loadComment(env, commentId);
  if (!comment || comment.agent_id !== who) return err("not_found", "No such comment.", 404);

  const now = nowISO();
  const db = env.DB;
  await db.batch([
    db
      .prepare("UPDATE corrections SET resolved_at = ? WHERE comment_id = ? AND resolved_at IS NULL")
      .bind(now, commentId),
    db.prepare("DELETE FROM comments WHERE id = ?").bind(commentId),
  ]);

  return json({ ok: true, deleted: true });
};
