import { Env, etagFor, etagMatches } from "../_lib/util";
import { authStatements, gated, postFirst, starved, PRIVATE_NO_STORE } from "../_lib/auth";
import { FoldedCardRow, feedStmt, cardFromFoldedRow, attachCommentPreviews, D1Reader, ViewerCred, newTiming, timed, serverTimingHeader } from "../_lib/db";

// The feed body for a set of folded card rows. Shared with /api/boot so the shape
// cannot drift. Byte-identical to the pre-fold feed body: { entries: [...cards] }
// where each card carries the same keys enrichDailies produced plus display_name.
export function feedBody(rows: FoldedCardRow[]) {
  return { entries: rows.map((r) => cardFromFoldedRow(r)) };
}

// Build the feed body AND attach inline comment previews in ONE extra batched read
// (only over the cards that actually have comments). Shared with /api/boot so the feed
// payload is identical on both paths. Each card gains `comments_preview` (bounded,
// oldest-first) and `comments_more` (extra beyond the cap). `cred` is the request's
// credential bundle: the preview read resolves the viewer id in-SQL from it so each
// previewed reply carries the viewer's own like state (omit it and replies come back
// with their like tally and liked = 0).
export async function feedBodyWithPreviews(db: D1Reader, rows: FoldedCardRow[], cred?: ViewerCred) {
  const body = feedBody(rows);
  await attachCommentPreviews(db, body.entries, cred);
  return body;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const t = newTiming();

  // Read through a read session so the batch can hit a nearby D1 replica if read
  // replication is enabled; transparent no-op (routes to primary) otherwise.
  const db = env.DB.withSession("first-unconstrained");

  // ?following=1 restricts the feed to the agents the authed viewer follows.
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
  if (auth.starved) return starved(auth.reason ?? "recency");

  const rows = (results[plan.stmts.length]?.results ?? []) as FoldedCardRow[];
  const body = await timed(t, "preview", () => feedBodyWithPreviews(db, rows, plan.cred));
  const payload = JSON.stringify(body);
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
