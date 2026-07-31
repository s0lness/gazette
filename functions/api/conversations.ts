import { Env } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";

// List the viewer's DM conversations. A conversation is keyed by (agent_id, visitor_hash)
// in dm_log, where visitor_hash is either "member:<id>" (the global thread) or
// "member:<id>:p<projectId>" (a project thread). We fold every row for this viewer into
// one entry per thread: the last question/answer, when, and how many turns.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;
  const db = env.DB;

  // One grouped read over dm_log for this viewer's two visitor_hash shapes: the exact
  // global thread ("member:<id>") OR any project thread ("member:<id>:p%"). We group by
  // (agent_id, visitor_hash) to get one row per thread with its last turn and count.
  const exact = "member:" + me;
  const likePattern = "member:" + me + ":p%";
  const grouped = await db
    .prepare(
      `SELECT agent_id, visitor_hash,
              COUNT(*) AS count,
              MAX(created_at) AS last_at
       FROM dm_log
       WHERE visitor_hash = ? OR visitor_hash LIKE ?
       GROUP BY agent_id, visitor_hash`,
    )
    .bind(exact, likePattern)
    .all<{ agent_id: number; visitor_hash: string; count: number; last_at: string }>();
  const rows = grouped.results ?? [];
  if (rows.length === 0) return readerJson(auth, { ok: true, conversations: [] });

  // The last question/answer for each thread: the row at its MAX(created_at). Fetch the
  // viewer's rows newest-first once and keep the first seen per (agent_id, visitor_hash).
  const lastTurns = await db
    .prepare(
      `SELECT agent_id, visitor_hash, question, answer, created_at
       FROM dm_log
       WHERE visitor_hash = ? OR visitor_hash LIKE ?
       ORDER BY created_at DESC`,
    )
    .bind(exact, likePattern)
    .all<{ agent_id: number; visitor_hash: string; question: string; answer: string; created_at: string }>();
  const lastByThread = new Map<string, { question: string; answer: string }>();
  for (const r of lastTurns.results ?? []) {
    const key = r.agent_id + "|" + r.visitor_hash;
    if (!lastByThread.has(key)) lastByThread.set(key, { question: r.question, answer: r.answer });
  }

  // Parse the project id out of a project thread's visitor_hash ("member:<id>:p<pid>").
  const projectIdOf = (visitorHash: string): number | null => {
    const m = /:p(\d+)$/.exec(visitorHash);
    return m ? Number(m[1]) : null;
  };

  const agentIds = [...new Set(rows.map((r) => r.agent_id))];
  const projectIds = [...new Set(rows.map((r) => projectIdOf(r.visitor_hash)).filter((x): x is number => x !== null))];

  // Batch-resolve the agents and projects referenced by these threads.
  const stmts = [
    db
      .prepare(`SELECT id, handle FROM agents WHERE id IN (${agentIds.map(() => "?").join(",")})`)
      .bind(...agentIds),
  ];
  if (projectIds.length > 0) {
    stmts.push(
      db
        .prepare(`SELECT id, name, slug FROM projects WHERE id IN (${projectIds.map(() => "?").join(",")})`)
        .bind(...projectIds),
    );
  }
  const res = await db.batch<any>(stmts);
  const agentById = new Map<number, { handle: string }>();
  for (const a of (res[0].results ?? []) as { id: number; handle: string }[]) {
    agentById.set(a.id, { handle: a.handle });
  }
  const projectById = new Map<number, { name: string; slug: string }>();
  if (projectIds.length > 0) {
    for (const p of (res[1].results ?? []) as { id: number; name: string; slug: string }[]) {
      projectById.set(p.id, { name: p.name, slug: p.slug });
    }
  }

  const conversations = rows
    .map((r) => {
      const agent = agentById.get(r.agent_id);
      const last = lastByThread.get(r.agent_id + "|" + r.visitor_hash);
      const pid = projectIdOf(r.visitor_hash);
      // A deleted project yields project: null but the row is kept.
      const project = pid !== null ? projectById.get(pid) ?? null : null;
      return {
        agent: { handle: agent?.handle ?? "", avatar_seed: agent?.handle ?? "" },
        project: project ? { name: project.name, slug: project.slug } : null,
        last_question: last?.question ?? "",
        last_answer: last?.answer ?? "",
        last_at: r.last_at,
        count: r.count,
      };
    })
    .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));

  return readerJson(auth, { ok: true, conversations });
};
