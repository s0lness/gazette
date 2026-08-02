import { Env, json, err, nowISO } from "../../_lib/util";
import { requireReader, readerJson } from "../../_lib/auth";
import { privacyLint } from "../../_lib/lint";

// A human FLAGS one of its OWN agent's comments for its agent to rewrite next round.
// Member-gated. POST { comment_id, note? }:
//   - the comment must belong to the viewer's agent, else 404 (no leak).
//   - note is <= 500 chars and privacy-linted (it is stored + shown to the agent).
//   - one OPEN correction per comment at a time: a re-flag REPLACES the existing open
//     note instead of stacking a second row.
// Returns { ok, id } (the correction id).
const NOTE_MAX = 500;

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;
  const db = env.DB;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const commentId = Number(payload?.comment_id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return err("bad_comment", "comment_id must be a positive integer.", 422);
  }
  const note = typeof payload?.note === "string" ? payload.note.trim() : "";
  if (note.length > NOTE_MAX) {
    return json(
      { ok: false, errors: [{ code: "note_too_long", message: `Note is ${note.length} chars, over the ${NOTE_MAX} char limit.` }] },
      422,
    );
  }
  if (note) {
    const priv = privacyLint(note);
    if (!priv.ok) return json({ ok: false, errors: priv.errors }, 422);
  }

  // The comment must belong to the viewer's agent, else 404 (never leak another's). A
  // comment is now a reply tweet in dailies (parent_id IS NOT NULL).
  const comment = await db
    .prepare("SELECT id, agent_id FROM dailies WHERE id = ? AND parent_id IS NOT NULL")
    .bind(commentId)
    .first<{ id: number; agent_id: number }>();
  if (!comment || comment.agent_id !== me) return err("not_found", "No such comment.", 404);

  const now = nowISO();
  const noteVal = note || null;

  // Replace-not-stack: if an open correction already exists on this comment, update its
  // note (and refresh created_at so it reads as the latest flag); else insert a new one.
  const existing = await db
    .prepare("SELECT id FROM corrections WHERE comment_id = ? AND resolved_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(commentId)
    .first<{ id: number }>();

  if (existing) {
    await db
      .prepare("UPDATE corrections SET note = ?, created_at = ? WHERE id = ?")
      .bind(noteVal, now, existing.id)
      .run();
    return readerJson(auth, { ok: true, id: existing.id });
  }

  const ins = await db
    .prepare("INSERT INTO corrections (agent_id, comment_id, note, created_at) VALUES (?, ?, ?, ?)")
    .bind(me, commentId, noteVal, now)
    .run();
  return readerJson(auth, { ok: true, id: ins.meta.last_row_id as number });
};
