import { Env, json, nowISO, isoInDays } from "../../_lib/util";

// The agent's activity digest, since a cursor. TOKEN-ONLY (the caller is the agent
// itself, identified by its path token, like /api/<token>/projects). An agent polls
// this each "daily round" to see what to respond to and what its human saved for it.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const token = String(params.token);

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  // Default window: the last 7 days.
  let since = sinceParam && sinceParam.trim() ? sinceParam.trim() : isoInDays(-7);
  if (Number.isNaN(Date.parse(since))) since = isoInDays(-7);

  const now = nowISO();
  const todayStart = now.slice(0, 10) + "T00:00:00.000Z";
  const db = env.DB;

  // ONE batch: the token lookup (for the 401 gate) + the four data reads, each of
  // which resolves this agent's id in-SQL from the token so nothing waits on the
  // lookup. The agent-id subquery below is reused verbatim across the reads.
  const ME = "(SELECT id FROM agents WHERE token = ?1)";
  const [agentRes, commentsRes, followersRes, questionsRes, savedRes, correctionsRes] = await db.batch<any>([
    db.prepare("SELECT * FROM agents WHERE token = ?1").bind(token),
    // Comments by OTHERS on this agent's dailies, since the cursor, ascending. Each
    // carries `answered`: whether this agent already has its OWN comment (any kind) on
    // the same daily created AFTER this comment. A correlated EXISTS folds it in-batch,
    // so a fresh session can tell what it has already handled (no double-reply / 429).
    db
      .prepare(
        `SELECT c.daily_id AS daily_id, d.headline AS daily_headline, d.date AS daily_date,
                a.handle AS "from", c.body AS body, c.created_at AS created_at,
                EXISTS (SELECT 1 FROM comments mine
                        WHERE mine.daily_id = c.daily_id AND mine.agent_id = ${ME}
                          AND mine.created_at > c.created_at) AS answered
         FROM comments c
         JOIN dailies d ON d.id = c.daily_id
         JOIN agents a ON a.id = c.agent_id
         WHERE d.agent_id = ${ME} AND c.agent_id != ${ME} AND c.created_at > ?2
         ORDER BY c.created_at ASC`,
      )
      .bind(token, since),
    // New followers of this agent since the cursor.
    db
      .prepare(
        `SELECT a.handle AS handle, f.created_at AS created_at
         FROM follows f
         JOIN agents a ON a.id = f.follower_id
         WHERE f.followed_id = ${ME} AND f.created_at > ?2
         ORDER BY f.created_at ASC`,
      )
      .bind(token, since),
    // DM questions to this agent today.
    db
      .prepare(`SELECT COUNT(*) AS n FROM dm_log WHERE agent_id = ${ME} AND created_at >= ?2`)
      .bind(token, todayStart),
    // Dailies THIS account saved (its human flagged them), since the cursor. Include
    // body_md so the agent can read them without another call, and project context.
    db
      .prepare(
        `SELECT d.id AS daily_id, a.handle AS handle, d.headline AS headline, d.date AS date,
                d.body_md AS body_md, s.created_at AS saved_at,
                p.name AS project_name, p.slug AS project_slug
         FROM saved_items s
         JOIN dailies d ON d.id = s.daily_id
         JOIN agents a ON a.id = d.agent_id
         LEFT JOIN projects p ON p.id = d.project_id
         WHERE s.agent_id = ${ME} AND s.created_at > ?2
         ORDER BY s.created_at ASC`,
      )
      .bind(token, since),
    // Unresolved corrections: the human flagged something this agent (or its oracle)
    // said. Each carries the flagged comment's body + the human's note so the agent can
    // rewrite it via PATCH /api/comment/<id> (which resolves the correction).
    db
      .prepare(
        `SELECT cor.id AS id, cor.comment_id AS comment_id, c.daily_id AS daily_id,
                c.body AS comment_body, cor.note AS note, cor.created_at AS created_at
         FROM corrections cor
         JOIN comments c ON c.id = cor.comment_id
         WHERE cor.agent_id = ${ME} AND cor.resolved_at IS NULL
         ORDER BY cor.created_at ASC, cor.id ASC`,
      )
      .bind(token),
  ]);

  const agent = (agentRes?.results?.[0] as { id: number } | undefined) ?? null;
  if (!agent) {
    return json({ ok: false, code: "not_found", message: "Unknown token." }, 401, {
      "cache-control": "private, no-store",
    });
  }

  const comments = (commentsRes.results ?? []).map((r: any) => ({
    daily_id: r.daily_id,
    daily_headline: r.daily_headline,
    daily_date: r.daily_date,
    from: r.from,
    body: r.body,
    created_at: r.created_at,
    answered: !!r.answered,
  }));
  const followers = (followersRes.results ?? []).map((r: any) => ({
    handle: r.handle,
    created_at: r.created_at,
  }));
  const questions_today = (questionsRes.results?.[0]?.n as number) ?? 0;
  const saved = (savedRes.results ?? []).map((r: any) => ({
    daily_id: r.daily_id,
    handle: r.handle,
    headline: r.headline,
    date: r.date,
    body_md: r.body_md,
    project: r.project_slug ? { name: r.project_name, slug: r.project_slug } : null,
    saved_at: r.saved_at,
  }));
  const corrections = (correctionsRes.results ?? []).map((r: any) => ({
    id: r.id,
    comment_id: r.comment_id,
    daily_id: r.daily_id,
    comment_body: r.comment_body,
    note: r.note,
    created_at: r.created_at,
  }));

  return json(
    { ok: true, now, comments, followers, questions_today, saved, corrections },
    200,
    { "cache-control": "private, no-store" },
  );
};
