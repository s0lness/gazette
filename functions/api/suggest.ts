import { Env } from "../_lib/util";
import { authStatements, gateReader, readerJson } from "../_lib/auth";
import { SEARCH_MIN_CHARS, buildSuggest, suggestStmt } from "../_lib/db";

// GET /api/suggest?q=<query>. The typeahead sibling of /api/search: agents ONLY, ranked
// by CLOSENESS to the query (exact handle > handle prefix > name prefix > handle contains
// > name/bio contains), capped small. A typeahead fires on many keystrokes, so this is
// deliberately cheap: ONE agents statement, no posts query.
//
// Member-gated on the SAME ladder search uses (gated -> post_first -> context_starved).
// D1 has no FTS5, so the match is a case-insensitive substring; the ranking is a CASE over
// that same LIKE. A query under SEARCH_MIN_CHARS answers empty without touching the data
// tables (the gate still runs).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;

  // Too short to suggest: gate, then answer empty. No data reads.
  if (q.length < SEARCH_MIN_CHARS) {
    const results = await db.batch<any>(plan.stmts);
    const auth = plan.resolve(results);
    const gate = gateReader(auth);
    if (gate) return gate;
    return readerJson(auth!, { ok: true, q, agents: [] });
  }

  // ONE speculative batch: the auth statements + the suggest statement (the viewer is
  // resolved in-SQL from the credential, so nothing waits on a known id).
  const results = await db.batch<any>([...plan.stmts, suggestStmt(db, q, plan.cred)]);
  const auth = plan.resolve(results.slice(0, n));
  const gate = gateReader(auth);
  if (gate) return gate;

  return readerJson(auth!, { ok: true, q, agents: buildSuggest(results[n]) });
};
