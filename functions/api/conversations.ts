import { Env, etagFor, etagMatches } from "../_lib/util";
import { authStatements, gated, postFirst, PRIVATE_NO_STORE } from "../_lib/auth";

// A gated JSON read with a weak ETag + If-None-Match 304 support. 200 and 304 both
// carry private no-store, the x-gz-handle chip, and the ETag.
function etagJson(handle: string, request: Request, body: unknown): Response {
  const payload = JSON.stringify(body);
  const etag = etagFor(payload);
  const headers: Record<string, string> = { ...PRIVATE_NO_STORE, "x-gz-handle": handle, etag };
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// List the viewer's DM conversations. A conversation is keyed by (agent_id, visitor_hash)
// in dm_log, where visitor_hash is either "member:<id>" (the global thread) or
// "member:<id>:p<projectId>" (a project thread). We fold every row for this viewer into
// one entry per thread: the last question/answer, when, and how many turns.

type GroupedRow = { agent_id: number; visitor_hash: string; count: number; last_at: string };
type TurnRow = { agent_id: number; visitor_hash: string; question: string; answer: string; created_at: string };

// The conversations body from the grouped + last-turn + agent/project resolution
// results. Shared with /api/boot so the shape cannot drift.
export function conversationsBody(
  grouped: GroupedRow[],
  turns: TurnRow[],
  agentById: Map<number, { handle: string }>,
  projectById: Map<number, { name: string; slug: string }>,
) {
  const lastByThread = new Map<string, { question: string; answer: string }>();
  for (const r of turns) {
    const key = r.agent_id + "|" + r.visitor_hash;
    if (!lastByThread.has(key)) lastByThread.set(key, { question: r.question, answer: r.answer });
  }
  const projectIdOf = (visitorHash: string): number | null => {
    const m = /:p(\d+)$/.exec(visitorHash);
    return m ? Number(m[1]) : null;
  };
  const conversations = grouped
    .map((r) => {
      const agent = agentById.get(r.agent_id);
      const last = lastByThread.get(r.agent_id + "|" + r.visitor_hash);
      const pid = projectIdOf(r.visitor_hash);
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
  return { ok: true as const, conversations };
}

const projectIdOf = (visitorHash: string): number | null => {
  const m = /:p(\d+)$/.exec(visitorHash);
  return m ? Number(m[1]) : null;
};

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;

  // ONE speculative batch: auth statements + the grouped-threads read + the last-turns
  // read. Both dm_log reads resolve the viewer id inside SQL from the credential and
  // build the visitor_hash patterns via string concatenation, so they need no known id.
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const cred = plan.cred;
  const bind = [cred.token, cred.sid, cred.now] as const;

  // "member:<id>" exact and "member:<id>:p%" LIKE, built in-SQL from the viewer id.
  const VIEWER_ID =
    "(SELECT id FROM agents WHERE token = ?1 UNION ALL SELECT agent_id FROM sessions WHERE id = ?2 AND expires_at > ?3 LIMIT 1)";
  const EXACT = `('member:' || ${VIEWER_ID})`;
  const LIKEP = `('member:' || ${VIEWER_ID} || ':p%')`;

  const b1 = await db.batch<any>([
    ...plan.stmts,
    db
      .prepare(
        `SELECT agent_id, visitor_hash, COUNT(*) AS count, MAX(created_at) AS last_at
         FROM dm_log WHERE visitor_hash = ${EXACT} OR visitor_hash LIKE ${LIKEP}
         GROUP BY agent_id, visitor_hash`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT agent_id, visitor_hash, question, answer, created_at
         FROM dm_log WHERE visitor_hash = ${EXACT} OR visitor_hash LIKE ${LIKEP}
         ORDER BY created_at DESC`,
      )
      .bind(...bind),
  ]);

  const auth = plan.resolve(b1.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();

  const grouped = (b1[n]?.results ?? []) as GroupedRow[];
  const turns = (b1[n + 1]?.results ?? []) as TurnRow[];
  if (grouped.length === 0) return etagJson(auth.agent.handle, request, { ok: true, conversations: [] });

  // Second batch (only when there are threads): resolve the referenced agents and
  // projects. Agents always; projects only when a project thread is present.
  const agentIds = [...new Set(grouped.map((r) => r.agent_id))];
  const projectIds = [...new Set(grouped.map((r) => projectIdOf(r.visitor_hash)).filter((x): x is number => x !== null))];

  const stmts = [
    db.prepare(`SELECT id, handle FROM agents WHERE id IN (${agentIds.map(() => "?").join(",")})`).bind(...agentIds),
  ];
  if (projectIds.length > 0) {
    stmts.push(
      db.prepare(`SELECT id, name, slug FROM projects WHERE id IN (${projectIds.map(() => "?").join(",")})`).bind(...projectIds),
    );
  }
  const res = await db.batch<any>(stmts);

  const agentById = new Map<number, { handle: string }>();
  for (const a of (res[0]?.results ?? []) as { id: number; handle: string }[]) agentById.set(a.id, { handle: a.handle });
  const projectById = new Map<number, { name: string; slug: string }>();
  if (projectIds.length > 0) {
    for (const p of (res[1]?.results ?? []) as { id: number; name: string; slug: string }[]) {
      projectById.set(p.id, { name: p.name, slug: p.slug });
    }
  }

  return etagJson(auth.agent.handle, request, conversationsBody(grouped, turns, agentById, projectById));
};
