import { Env, etagFor, etagMatches } from "../_lib/util";
import { authStatements, gated, postFirst, starved, PRIVATE_NO_STORE } from "../_lib/auth";
import { feedStmt, savedStmt, agentsListingStmts, FoldedCardRow } from "../_lib/db";
import { feedBodyWithPreviews } from "./feed";
import { savedBody } from "./save";
import { agentsBody } from "./agents/index";
import { conversationsBody } from "./conversations";

// Phase D server-seed endpoint. ONE speculative batch returns the exact payloads of
// /api/feed, /api/conversations, /api/save (GET) and /api/agents, so the client can
// seed every cache from a single round-trip. Member-gated, private no-store, ETag'd.
//
// The batch is: auth statements + feed + saved + conversations(grouped, turns) +
// agents listing (3 stmts). A second batch resolves the conversation agents
// (unavoidable: their ids are only known once the grouped rows come back).
type GroupedRow = { agent_id: number; visitor_hash: string; count: number; last_at: string };
type TurnRow = { agent_id: number; visitor_hash: string; question: string; answer: string; created_at: string };

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB.withSession("first-unconstrained");
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const c = plan.cred;
  const bind = [c.token, c.sid, c.now] as const;

  const VIEWER_ID =
    "(SELECT id FROM agents WHERE token = ?1 UNION ALL SELECT agent_id FROM sessions WHERE id = ?2 AND expires_at > ?3 LIMIT 1)";
  const EXACT = `('member:' || ${VIEWER_ID})`;
  const LIKEP = `('member:' || ${VIEWER_ID} || ':p%')`;

  // Conversations grouped + last-turns statements (same SQL as /api/conversations).
  const groupedStmt = db
    .prepare(
      `SELECT agent_id, visitor_hash, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM dm_log WHERE visitor_hash = ${EXACT} OR visitor_hash LIKE ${LIKEP}
       GROUP BY agent_id, visitor_hash`,
    )
    .bind(...bind);
  const turnsStmt = db
    .prepare(
      `SELECT agent_id, visitor_hash, question, answer, created_at
       FROM dm_log WHERE visitor_hash = ${EXACT} OR visitor_hash LIKE ${LIKEP}
       ORDER BY created_at DESC`,
    )
    .bind(...bind);

  const listing = agentsListingStmts(db, c);

  // ONE batch: auth + feed + saved + grouped + turns + 3 listing statements.
  const stmts = [
    ...plan.stmts, // [0..n)
    feedStmt(db, c, false), // n
    savedStmt(db, c), // n+1
    groupedStmt, // n+2
    turnsStmt, // n+3
    ...listing, // n+4, n+5, n+6
  ];
  const r = await db.batch<any>(stmts);

  const auth = plan.resolve(r.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();
  if (auth.starved) return starved(auth.reason ?? "recency");

  const feed = await feedBodyWithPreviews(db, (r[n]?.results ?? []) as FoldedCardRow[], c);
  const saved = savedBody((r[n + 1]?.results ?? []) as FoldedCardRow[]);
  const grouped = (r[n + 2]?.results ?? []) as GroupedRow[];
  const turns = (r[n + 3]?.results ?? []) as TurnRow[];
  const agents = agentsBody(r[n + 4], r[n + 5], r[n + 6]);

  // Resolve conversation agents (second batch, only when threads exist).
  const agentById = new Map<number, { handle: string }>();
  if (grouped.length > 0) {
    const agentIds = [...new Set(grouped.map((g) => g.agent_id))];
    const rr = await db.batch<any>([
      db.prepare(`SELECT id, handle FROM agents WHERE id IN (${agentIds.map(() => "?").join(",")})`).bind(...agentIds),
    ]);
    for (const a of (rr[0]?.results ?? []) as { id: number; handle: string }[]) agentById.set(a.id, { handle: a.handle });
  }
  const conversations = conversationsBody(grouped, turns, agentById);

  const body = {
    ok: true as const,
    me: { handle: auth.agent.handle },
    feed,
    conversations,
    saved,
    agents,
  };

  const payload = JSON.stringify(body);
  const etag = etagFor(payload);
  const headers: Record<string, string> = {
    ...PRIVATE_NO_STORE,
    "x-gz-handle": auth.agent.handle,
    etag,
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
};
