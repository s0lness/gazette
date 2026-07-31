import { Env, etagFor, etagMatches } from "../_lib/util";
import { authStatements, gated, postFirst, PRIVATE_NO_STORE } from "../_lib/auth";
import { FoldedCardRow, feedStmt, cardFromFoldedRow, newTiming, timed, serverTimingHeader } from "../_lib/db";

// The feed body for a set of folded card rows. Shared with /api/boot so the shape
// cannot drift. Byte-identical to the pre-fold feed body: { entries: [...cards] }
// where each card carries the same keys enrichDailies produced plus display_name.
export function feedBody(rows: FoldedCardRow[]) {
  return { entries: rows.map((r) => cardFromFoldedRow(r)) };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const t = newTiming();

  // Read through a read session so the batch can hit a nearby D1 replica if read
  // replication is enabled; transparent no-op (routes to primary) otherwise.
  const db = env.DB.withSession("first-unconstrained");

  // ?following=1 restricts the feed to agents/projects the authed viewer follows.
  const following = new URL(request.url).searchParams.get("following") === "1";

  // ONE speculative batch: the four auth statements + the SQL-folded feed statement.
  // The feed statement resolves the viewer id inside SQL from the same credential
  // (plan.cred), so nothing depends on an id we do not yet have. We run everything,
  // resolve auth from the leading slice, and only THEN decide to return the body or a
  // gate. The feed rows are cheap reads; discarding them on auth failure is fine.
  const plan = authStatements(env, request, db);
  const stmts = [...plan.stmts, feedStmt(db, plan.cred, following)];

  const results = await timed(t, "feed", () => db.batch<any>(stmts));
  const auth = plan.resolve(results.slice(0, plan.stmts.length));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();

  const rows = (results[plan.stmts.length]?.results ?? []) as FoldedCardRow[];
  const payload = JSON.stringify(feedBody(rows));
  return respond(payload, auth.agent.handle, request, t);
};

// 200 with the JSON, or 304 when If-None-Match matches the weak ETag. Both carry the
// private no-store headers, the x-gz-handle chip, the ETag, and Server-Timing.
function respond(payload: string, handle: string, request: Request, t: ReturnType<typeof newTiming>): Response {
  const etag = etagFor(payload);
  const headers: Record<string, string> = {
    ...PRIVATE_NO_STORE,
    "x-gz-handle": handle,
    etag,
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    const r304 = new Response(null, { status: 304, headers });
    r304.headers.set("server-timing", serverTimingHeader(t));
    return r304;
  }
  const res = new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
  res.headers.set("server-timing", serverTimingHeader(t));
  return res;
}
