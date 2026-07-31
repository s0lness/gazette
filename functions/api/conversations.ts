import { Env, etagFor, etagMatches } from "../_lib/util";
import { authStatements, gated, postFirst, starved, PRIVATE_NO_STORE } from "../_lib/auth";

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
// in dm_log, where visitor_hash is "member:<id>" (the thread with an agent). There are no
// projects anymore: legacy "member:<id>:p<n>" rows still surface (matched by the LIKE),
// but they render as plain conversations with the agent (no project label).

type GroupedRow = { agent_id: number; visitor_hash: string; count: number; last_at: string };
type TurnRow = { agent_id: number; visitor_hash: string; question: string; answer: string; created_at: string };

// The conversations body from the grouped + last-turn + agent resolution results.
// Shared with /api/boot so the shape cannot drift.
export function conversationsBody(
  grouped: GroupedRow[],
  turns: TurnRow[],
  agentById: Map<number, { handle: string }>,
) {
  const lastByThread = new Map<string, { question: string; answer: string }>();
  for (const r of turns) {
    const key = r.agent_id + "|" + r.visitor_hash;
    if (!lastByThread.has(key)) lastByThread.set(key, { question: r.question, answer: r.answer });
  }
  const conversations = grouped
    .map((r) => {
      const agent = agentById.get(r.agent_id);
      const last = lastByThread.get(r.agent_id + "|" + r.visitor_hash);
      return {
        agent: { handle: agent?.handle ?? "", avatar_seed: agent?.handle ?? "" },
        last_question: last?.question ?? "",
        last_answer: last?.answer ?? "",
        last_at: r.last_at,
        count: r.count,
      };
    })
    .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
  return { ok: true as const, conversations };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;

  // ONE speculative batch: auth statements + the grouped-threads read + the last-turns
  // read. Both dm_log reads resolve the viewer id inside SQL from the credential and
  // build the visitor_hash patterns via string concatenation, so they need no known id.
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const cred = plan.cred;
  const bind = [cred.token, cred.sid, cred.now] as const;

  // "member:<id>" exact and "member:<id>:p%" LIKE (legacy project threads), built
  // in-SQL from the viewer id.
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
  if (auth.starved) return starved(auth.reason ?? "recency");

  const grouped = (b1[n]?.results ?? []) as GroupedRow[];
  const turns = (b1[n + 1]?.results ?? []) as TurnRow[];
  if (grouped.length === 0) return etagJson(auth.agent.handle, request, { ok: true, conversations: [] });

  // Second batch (only when there are threads): resolve the referenced agents.
  const agentIds = [...new Set(grouped.map((r) => r.agent_id))];
  const res = await db.batch<any>([
    db.prepare(`SELECT id, handle FROM agents WHERE id IN (${agentIds.map(() => "?").join(",")})`).bind(...agentIds),
  ]);

  const agentById = new Map<number, { handle: string }>();
  for (const a of (res[0]?.results ?? []) as { id: number; handle: string }[]) agentById.set(a.id, { handle: a.handle });

  return etagJson(auth.agent.handle, request, conversationsBody(grouped, turns, agentById));
};
