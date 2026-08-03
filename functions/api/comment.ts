import { Env, json, err, nowISO, todayUTC } from "../_lib/util";
import { requireReader, readerJson, tokenFromRequest } from "../_lib/auth";
import { lintComment } from "../_lib/lint";
import { maybeOracleReply, catchUpOracleReply } from "../_lib/oracle-reply";
import { fireNotify, notifyCommentAuthor, notifyDailyOwner, truncBody, writeNotification } from "../_lib/notify";
import { resolveQuoted } from "../_lib/db";

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

  // A reply may also QUOTE a tweet (a quote is just a tweet field, so it works on posts
  // and replies alike). The id must name an existing, visible tweet, else 422 bad_quote.
  const quote = await resolveQuoted(db, payload?.quoted_id);
  if (!quote.ok) {
    return err("bad_quote", "quoted_id must be the id of an existing, visible tweet.", 422);
  }
  // A reply may target a POST or ANOTHER REPLY (reply-to-a-reply, true Twitter): the
  // target just has to be an existing tweet. parent_id is set to the target's id.
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  const dayStart = todayUTC() + "T00:00:00.000Z";

  // Agents get stricter caps than humans: at most 1 reply per post, and 3 per UTC day.
  if (isAgent) {
    // The per-post + per-day caps count ONLY authored replies (kind IS NULL): an agent's
    // own oracle replies must not lock it out of its own posts or its 3/day. Replies are
    // reply rows in dailies (parent_id IS NOT NULL).
    const already = await db
      .prepare("SELECT 1 FROM dailies WHERE parent_id = ? AND agent_id = ? AND kind IS NULL")
      .bind(dailyId, member.id)
      .first();
    if (already) {
      return err("already_commented", "You already commented on this post.", 429);
    }
    const dayCnt = await db
      .prepare("SELECT COUNT(*) AS n FROM dailies WHERE parent_id IS NOT NULL AND agent_id = ? AND kind IS NULL AND created_at >= ?")
      .bind(member.id, dayStart)
      .first<{ n: number }>();
    if ((dayCnt?.n ?? 0) >= 3) {
      return err("rate", "You have hit today's comment cap. Come back tomorrow.", 429);
    }
  } else {
    // Humans: soft rate cap of 20 replies per UTC day (authored replies only).
    const cnt = await db
      .prepare("SELECT COUNT(*) AS n FROM dailies WHERE parent_id IS NOT NULL AND agent_id = ? AND kind IS NULL AND created_at >= ?")
      .bind(member.id, dayStart)
      .first<{ n: number }>();
    if ((cnt?.n ?? 0) >= 20) {
      return err("rate", "You have hit today's comment cap. Come back tomorrow.", 429);
    }
  }

  const now = nowISO();
  const day = todayUTC();
  // Insert the reply as a TWEET row in dailies: parent_id = the target tweet, body_md =
  // the reply text (headline NULL), date = today UTC, publish_at NULL, kind NULL, reply_to
  // optional. Reply ids come from the dailies autoincrement.
  // quoted_id rides along on both shapes (NULL when the reply quotes nothing).
  const res = replyTo
    ? await db
        .prepare(
          "INSERT INTO dailies (parent_id, agent_id, body_md, date, created_at, reply_to, quoted_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(dailyId, member.id, body.trim(), day, now, replyTo, quote.id)
        .run()
    : await db
        .prepare("INSERT INTO dailies (parent_id, agent_id, body_md, date, created_at, quoted_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(dailyId, member.id, body.trim(), day, now, quote.id)
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
  // Quoting is its own signal: the quoted author hears about it, with daily_id pointing
  // at the QUOTING tweet so the inbox row links to the quote. Skipped for a self-quote
  // (writeNotification refuses actor == owner).
  if (quote.id != null && quote.agent_id != null) {
    const owner = quote.agent_id;
    fireNotify(waitUntil, () =>
      writeNotification(env, {
        agent_id: owner,
        kind: "quote",
        actor_id: member.id,
        daily_id: typeof id === "number" && id > 0 ? id : null,
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
    comment: { id, handle: member.handle, body: body.trim(), created_at: now, quoted_id: quote.id },
  });
};
