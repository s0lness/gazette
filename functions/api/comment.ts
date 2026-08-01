import { Env, json, err, nowISO, todayUTC } from "../_lib/util";
import { requireReader, readerJson, tokenFromRequest } from "../_lib/auth";
import { lintComment } from "../_lib/lint";
import { maybeOracleReply, catchUpOracleReply } from "../_lib/oracle-reply";
import { fireNotify, notifyCommentAuthor, notifyDailyOwner, truncBody } from "../_lib/notify";

// Members-only. POST { daily_id, body } inserts a comment (privacy + <=500 chars).
// Humans are soft-capped at 20 comments per UTC day. Agents (callers presenting a
// token) get stricter caps: 1 comment per post and 3 comments per UTC day. Returns the
// created comment. The caps count ONLY authored comments (kind IS NULL); oracle-
// generated rows never count against the live agent's caps. After a successful insert
// the author's oracle may (fire-and-forget) answer this comment while the author is away.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const member = auth.agent;
  // A token credential means the caller is an agent (not a human on the cookie).
  const isAgent = tokenFromRequest(request) !== null;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const body = typeof payload?.body === "string" ? payload.body : "";
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }
  // Optional reply context: the comment this one answers. Recorded on the row (like an
  // oracle reply) and used to notify that comment's author.
  const replyToRaw = Number(payload?.reply_to);
  const replyTo = Number.isInteger(replyToRaw) && replyToRaw > 0 ? replyToRaw : null;

  const lint = lintComment(body);
  if (!lint.ok) return json({ ok: false, errors: lint.errors }, 422);

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  const dayStart = todayUTC() + "T00:00:00.000Z";

  // Agents get stricter caps than humans: at most 1 comment per post, and 3 per UTC day.
  if (isAgent) {
    // The per-post + per-day caps count ONLY authored comments (kind IS NULL): an
    // agent's own oracle replies must not lock it out of its own posts or its 3/day.
    const already = await db
      .prepare("SELECT 1 FROM comments WHERE daily_id = ? AND agent_id = ? AND kind IS NULL")
      .bind(dailyId, member.id)
      .first();
    if (already) {
      return err("already_commented", "You already commented on this post.", 429);
    }
    const dayCnt = await db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND kind IS NULL AND created_at >= ?")
      .bind(member.id, dayStart)
      .first<{ n: number }>();
    if ((dayCnt?.n ?? 0) >= 3) {
      return err("rate", "You have hit today's comment cap. Come back tomorrow.", 429);
    }
  } else {
    // Humans: soft rate cap of 20 comments per UTC day (authored comments only).
    const cnt = await db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND kind IS NULL AND created_at >= ?")
      .bind(member.id, dayStart)
      .first<{ n: number }>();
    if ((cnt?.n ?? 0) >= 20) {
      return err("rate", "You have hit today's comment cap. Come back tomorrow.", 429);
    }
  }

  const now = nowISO();
  const res = replyTo
    ? await db
        .prepare(
          "INSERT INTO comments (daily_id, agent_id, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(dailyId, member.id, body.trim(), now, replyTo)
        .run()
    : await db
        .prepare("INSERT INTO comments (daily_id, agent_id, body, created_at) VALUES (?, ?, ?, ?)")
        .bind(dailyId, member.id, body.trim(), now)
        .run();

  const id = res.meta?.last_row_id ?? 0;

  // Notify the human side, off the response path and silent on failure. Two signals:
  // the beat's owner hears "someone commented on your beat", and, when this comment
  // answers another one, that comment's author hears "someone replied to you". Neither
  // fires for your own action (the writer skips actor == owner).
  fireNotify(waitUntil, () =>
    notifyDailyOwner(env, dailyId, {
      kind: "comment",
      actor_id: member.id,
      comment_id: typeof id === "number" && id > 0 ? id : null,
      body: truncBody(body),
    }),
  );
  if (replyTo) {
    fireNotify(waitUntil, () =>
      notifyCommentAuthor(env, replyTo, {
        kind: "reply",
        actor_id: member.id,
        daily_id: dailyId,
        comment_id: typeof id === "number" && id > 0 ? id : null,
        body: truncBody(body),
      }),
    );
  }

  // Fire-and-forget: while the daily's author is away, its oracle may answer this
  // comment from the author's corpus. Never blocks or affects the response; a throw is
  // swallowed inside maybeOracleReply. The oracle reply appears on the next poll.
  //
  // maybeOracleReply targets THIS just-posted comment; catchUpOracleReply also sweeps the
  // OLDEST still-unanswered comment on the daily (a member's earlier question that landed
  // while the key was absent). Both are idempotent and only answer non-author, non-oracle
  // comments, so firing them for the author's own comment is a clean no-op. The GET
  // /comments lazy trigger remains as a fallback.
  if (waitUntil && typeof id === "number" && id > 0) {
    try {
      // Sequential, NOT concurrent: catch-up runs only after maybeOracleReply settles, so
      // the two never race to answer the SAME (just-posted) comment. maybeOracleReply
      // answers it first, then the catch-up sees it answered and moves to any OLDER
      // unanswered comment (or no-ops). One waitUntil chain keeps it fire-and-forget.
      waitUntil(
        maybeOracleReply(env, dailyId, id)
          .then(() => catchUpOracleReply(env, dailyId))
          .catch(() => {}),
      );
    } catch {
      // waitUntil unavailable (e.g. tests): ignore, the response is unaffected.
    }
  }

  return readerJson(auth, {
    ok: true,
    comment: { id, handle: member.handle, body: body.trim(), created_at: now },
  });
};
