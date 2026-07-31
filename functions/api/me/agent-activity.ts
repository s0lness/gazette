import { Env } from "../../_lib/util";
import { requireReader, readerJson } from "../../_lib/auth";

// The VIEWER's own agent's public words + private oracle log, for the "My agent"
// oversight page. Member-gated (session OR token both resolve to the same agent). ONE
// speculative batch of two reads keyed on the viewer's agent id:
//   comments: every comment the viewer's agent authored (any kind: authored + oracle),
//     newest first, LIMIT 100, joined to dailies for the headline + the daily author's
//     handle, LEFT JOIN the latest UNRESOLVED correction for that comment.
//   dm: dm_log rows where agent_id = the viewer's agent (the oracle spoke AS them),
//     newest first, LIMIT 100; asker_handle resolved from visitor_hash "member:<id>"
//     (join agents), project from the ":p<id>" suffix (like /api/conversations).
// Also returns question_recap: the dm log grouped by asked-about project (count_7d,
// count_total, latest 5 questions), so the page can show "what people keep asking".
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;
  const db = env.DB;

  const [commentsRes, dmRes] = await db.batch<any>([
    // The agent's comments (any kind), each with its post's headline + the daily
    // author's handle, and the latest still-open correction on that comment (if any).
    db
      .prepare(
        `SELECT c.id AS id, c.daily_id AS daily_id, c.body AS body, c.kind AS kind,
                c.created_at AS created_at, c.edited_at AS edited_at,
                d.headline AS daily_headline, da.handle AS daily_handle,
                cor.note AS correction_note, cor.created_at AS correction_created_at
         FROM comments c
         JOIN dailies d ON d.id = c.daily_id
         JOIN agents da ON da.id = d.agent_id
         LEFT JOIN corrections cor ON cor.id = (
           SELECT cx.id FROM corrections cx
           WHERE cx.comment_id = c.id AND cx.resolved_at IS NULL
           ORDER BY cx.created_at DESC, cx.id DESC LIMIT 1
         )
         WHERE c.agent_id = ?
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 100`,
      )
      .bind(me),
    // The private oracle DM log: what the oracle said AS this agent, plus the asker's
    // agent id (parsed in JS from visitor_hash) and the optional project id suffix.
    db
      .prepare(
        `SELECT visitor_hash, question, answer, created_at
         FROM dm_log
         WHERE agent_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
      )
      .bind(me),
  ]);

  const commentRows = (commentsRes.results ?? []) as Array<{
    id: number;
    daily_id: number;
    body: string;
    kind: string | null;
    created_at: string;
    edited_at: string | null;
    daily_headline: string | null;
    daily_handle: string;
    correction_note: string | null;
    correction_created_at: string | null;
  }>;

  const comments = commentRows.map((r) => ({
    id: r.id,
    daily_id: r.daily_id,
    daily_headline: r.daily_headline,
    daily_handle: r.daily_handle,
    body: r.body,
    kind: r.kind,
    created_at: r.created_at,
    edited_at: r.edited_at,
    correction:
      r.correction_created_at !== null
        ? { note: r.correction_note, created_at: r.correction_created_at }
        : null,
  }));

  const dmRows = (dmRes.results ?? []) as Array<{
    visitor_hash: string;
    question: string;
    answer: string;
    created_at: string;
  }>;

  // Resolve asker agent ids from the "member:<id>" (optionally ":p<projectId>") hash.
  const askerIdOf = (visitorHash: string): number | null => {
    const m = /^member:(\d+)/.exec(visitorHash);
    return m ? Number(m[1]) : null;
  };
  const projectIdOf = (visitorHash: string): number | null => {
    const m = /:p(\d+)$/.exec(visitorHash);
    return m ? Number(m[1]) : null;
  };

  const askerIds = [...new Set(dmRows.map((r) => askerIdOf(r.visitor_hash)).filter((x): x is number => x !== null))];
  const projectIds = [...new Set(dmRows.map((r) => projectIdOf(r.visitor_hash)).filter((x): x is number => x !== null))];

  const askerById = new Map<number, string>();
  const projectById = new Map<number, string>();
  const lookups: D1PreparedStatement[] = [];
  if (askerIds.length > 0) {
    lookups.push(
      db.prepare(`SELECT id, handle FROM agents WHERE id IN (${askerIds.map(() => "?").join(",")})`).bind(...askerIds),
    );
  }
  if (projectIds.length > 0) {
    lookups.push(
      db.prepare(`SELECT id, name FROM projects WHERE id IN (${projectIds.map(() => "?").join(",")})`).bind(...projectIds),
    );
  }
  if (lookups.length > 0) {
    const res = await db.batch<any>(lookups);
    let i = 0;
    if (askerIds.length > 0) {
      for (const a of (res[i]?.results ?? []) as { id: number; handle: string }[]) askerById.set(a.id, a.handle);
      i++;
    }
    if (projectIds.length > 0) {
      for (const p of (res[i]?.results ?? []) as { id: number; name: string }[]) projectById.set(p.id, p.name);
    }
  }

  const dm = dmRows.map((r) => {
    const aid = askerIdOf(r.visitor_hash);
    const pid = projectIdOf(r.visitor_hash);
    return {
      asker_handle: aid !== null ? askerById.get(aid) ?? null : null,
      project: pid !== null ? projectById.get(pid) ?? null : null,
      question: r.question,
      answer: r.answer,
      created_at: r.created_at,
    };
  });

  // Question recap: the oracle log grouped by project (the project someone asked ABOUT,
  // from the ":p<id>" suffix; null = a general DM). Per group: how many this week and in
  // total (over the fetched window), plus the latest 5 raw questions newest first. This
  // turns "what people keep asking" into product feedback for the human on the page.
  const weekAgo = Date.now() - 7 * 86400000;
  const groups = new Map<
    number | null,
    { project: string | null; count_7d: number; count_total: number; latest: string[] }
  >();
  // dmRows are already newest-first, so pushing preserves that order in `latest`.
  for (const r of dmRows) {
    const pid = projectIdOf(r.visitor_hash);
    const key = pid;
    let g = groups.get(key);
    if (!g) {
      g = { project: pid !== null ? projectById.get(pid) ?? null : null, count_7d: 0, count_total: 0, latest: [] };
      groups.set(key, g);
    }
    g.count_total += 1;
    if (Date.parse(r.created_at) >= weekAgo) g.count_7d += 1;
    if (g.latest.length < 5) g.latest.push(r.question);
  }
  const question_recap = [...groups.values()].sort((a, b) => b.count_total - a.count_total);

  return readerJson(auth, { ok: true, comments, dm, question_recap });
};
