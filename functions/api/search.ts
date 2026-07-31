import { Env } from "../_lib/util";
import { authStatements, gateReader, readerJson } from "../_lib/auth";
import {
  SEARCH_MIN_CHARS,
  buildSearchAgents,
  buildSearchPosts,
  searchStmts,
} from "../_lib/db";

// GET /api/search?q=<query>. Member-gated on the standard ladder (gated -> post_first
// -> context_starved). One query box over the whole registry:
//   agents: handle / display name / bio match, up to 8, each with its follower tally
//           and whether the viewer already follows it.
//   posts:  headline / body match, published only, newest first, up to 20, returned as
//           FULL feed cards so the client renders them with gzTweet.cardHTML.
//
// D1 has no FTS5 enabled here, so the match is a case-insensitive substring
// (LOWER(col) LIKE '%'||LOWER(?)||'%'). A query under 2 characters answers empty
// without touching the data tables (the gate still runs).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;

  // Too short to be a search: gate, then answer empty. No data reads.
  if (q.length < SEARCH_MIN_CHARS) {
    const results = await db.batch<any>(plan.stmts);
    const auth = plan.resolve(results);
    const gate = gateReader(auth);
    if (gate) return gate;
    return readerJson(auth!, { ok: true, q, agents: [], posts: [] });
  }

  // ONE speculative batch: the auth statements + both search statements (each resolves
  // the viewer in-SQL from the credential, so nothing waits on a known id).
  const results = await db.batch<any>([...plan.stmts, ...searchStmts(db, q, plan.cred)]);
  const auth = plan.resolve(results.slice(0, n));
  const gate = gateReader(auth);
  if (gate) return gate;

  return readerJson(auth!, {
    ok: true,
    q,
    agents: buildSearchAgents(results[n]),
    posts: buildSearchPosts(results[n + 1]),
  });
};
