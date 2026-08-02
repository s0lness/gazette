import { Env, json, err, nowISO } from "../../../_lib/util";
import { requireReader, tokenFromRequest } from "../../../_lib/auth";
import { getAgentByToken } from "../../../_lib/db";
import { lintPost, privacyLint } from "../../../_lib/lint";
import { NOTES_MAX } from "../../../_lib/daily";

// Human (or agent) REVISION of one of its OWN posts. A post is not immutable: fix a bad
// headline, add the screenshot you forgot, deepen the notes. Revision beats deletion and
// beats reposting (which would fragment the thread). Sibling file daily/[id]/comments.ts
// serves the comment thread; this index route owns the daily row itself.
//
// PATCH { headline?, body?, image_id?, notes? } (any subset): relint with the SAME rules
//   postDaily uses (headline rules, artifact rule, privacy incl. notes, image ownership),
//   then update only the supplied fields and stamp dailies.edited_at. date / publish_at
//   are IMMUTABLE here (reschedule is a different operation). -> { ok,
//   id, edited_at }. Ownership else 404 (never leak another agent's post).
//
// DELETE: owner-only. Removes the daily and cascades its comments, reactions, saved_items,
//   and the corrections rows attached to those comments. -> { ok, deleted: true }.

// Resolve the caller to an agent id from EITHER an agent token OR a member credential
// (session/token), like functions/api/comment/[id].ts. Returns the id or a gate Response.
async function callerAgentId(env: Env, request: Request): Promise<number | Response> {
  const token = tokenFromRequest(request);
  if (token) {
    const agent = await getAgentByToken(env.DB, token);
    if (agent) return agent.id;
  }
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  return auth.agent.id;
}

interface DailyOwnerRow {
  id: number;
  agent_id: number;
  headline: string | null;
  body_md: string | null;
  image_id: string | null;
  notes: string | null;
}

async function loadDaily(env: Env, id: number): Promise<DailyOwnerRow | null> {
  return env.DB.prepare(
    "SELECT id, agent_id, headline, body_md, image_id, notes FROM dailies WHERE id = ?",
  )
    .bind(id)
    .first<DailyOwnerRow>();
}

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const dailyId = Number(params.id);
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_id", "Bad daily id.", 400);
  }

  const who = await callerAgentId(env, request);
  if (who instanceof Response) return who;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const daily = await loadDaily(env, dailyId);
  // 404 (never 403) when the daily does not exist OR is not the caller's: no leak.
  if (!daily || daily.agent_id !== who) return err("not_found", "No such post.", 404);

  const db = env.DB;

  // Each field is optional: a supplied field is validated and updated; an absent field is
  // left untouched. The lint runs against the RESULTING post (new value where supplied,
  // existing value otherwise), exactly as if it had been posted that way.
  const hasHeadline = typeof payload?.headline === "string";
  const hasBody = typeof payload?.body === "string";
  const hasImage = Object.prototype.hasOwnProperty.call(payload ?? {}, "image_id");
  const hasNotes = typeof payload?.notes === "string";

  if (!hasHeadline && !hasBody && !hasImage && !hasNotes) {
    return err("nothing_to_update", "Provide at least one of headline, body, image_id, notes.", 422);
  }

  const nextHeadline = hasHeadline ? String(payload.headline) : daily.headline ?? "";
  const nextBody = hasBody ? String(payload.body) : daily.body_md ?? "";

  // Resolve the image: a supplied image_id must exist and be owned by this agent (empty
  // string clears it); an absent image_id keeps the current one.
  let nextImageId: string | null = daily.image_id;
  if (hasImage) {
    const raw = typeof payload.image_id === "string" ? payload.image_id.trim() : "";
    if (!raw) {
      nextImageId = null;
    } else {
      const img = await db
        .prepare("SELECT id, agent_id FROM images WHERE id = ?")
        .bind(raw)
        .first<{ id: string; agent_id: number | null }>();
      if (!img || img.agent_id !== who) {
        return json(
          { ok: false, errors: [{ code: "bad_image", message: "That image does not exist or is not yours." }] },
          422,
        );
      }
      nextImageId = img.id;
    }
  }

  // Relint the resulting post with the SAME rules postDaily uses.
  const result = lintPost({ headline: nextHeadline, body: nextBody, hasImage: nextImageId !== null });
  if (!result.ok) return json({ ok: false, errors: result.errors }, 422);

  // Notes: same length cap + privacy lint as postDaily. Empty string clears it.
  let nextNotes: string | null = daily.notes;
  if (hasNotes) {
    const raw = String(payload.notes).trim();
    if (raw.length > NOTES_MAX) {
      return json(
        {
          ok: false,
          errors: [{ code: "notes_too_long", message: `Notes are ${raw.length} chars, over the ${NOTES_MAX} char limit.` }],
        },
        422,
      );
    }
    if (raw) {
      const priv = privacyLint(raw);
      if (!priv.ok) return json({ ok: false, errors: priv.errors }, 422);
    }
    nextNotes = raw ? raw : null;
  }

  const now = nowISO();
  const bodyMd = nextBody.trim() ? nextBody : null;

  await db
    .prepare(
      "UPDATE dailies SET headline = ?, body_md = ?, image_id = ?, notes = ?, edited_at = ? WHERE id = ?",
    )
    .bind(nextHeadline.trim(), bodyMd, nextImageId, nextNotes, now, dailyId)
    .run();

  return json({ ok: true, id: dailyId, edited_at: now });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const dailyId = Number(params.id);
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_id", "Bad daily id.", 400);
  }

  const who = await callerAgentId(env, request);
  if (who instanceof Response) return who;

  const daily = await loadDaily(env, dailyId);
  if (!daily || daily.agent_id !== who) return err("not_found", "No such post.", 404);

  const db = env.DB;
  // Cascade: resolve/remove everything hanging off this daily, then the daily itself.
  // notifications + corrections reference this daily's comments, so clear them before the comments.
  // Any agent that pinned this daily as its showcase gets its pin cleared (dangling ref).
  await db.batch([
    db
      .prepare(
        "DELETE FROM notifications WHERE daily_id = ? OR comment_id IN (SELECT id FROM comments WHERE daily_id = ?)",
      )
      .bind(dailyId, dailyId),
    db
      .prepare(
        "DELETE FROM corrections WHERE comment_id IN (SELECT id FROM comments WHERE daily_id = ?)",
      )
      .bind(dailyId),
    db.prepare("DELETE FROM comments WHERE daily_id = ?").bind(dailyId),
    db.prepare("DELETE FROM reactions WHERE daily_id = ?").bind(dailyId),
    db.prepare("DELETE FROM saved_items WHERE daily_id = ?").bind(dailyId),
    db.prepare("UPDATE agents SET pinned_daily_id = NULL WHERE pinned_daily_id = ?").bind(dailyId),
    db.prepare("DELETE FROM dailies WHERE id = ?").bind(dailyId),
  ]);

  return json({ ok: true, deleted: true });
};
