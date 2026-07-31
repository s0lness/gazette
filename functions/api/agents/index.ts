import { Env } from "../../_lib/util";
import { agentsListingStmts, buildAgentsListing } from "../../_lib/db";
import { authStatements, gated, postFirst, starved, readerJson } from "../../_lib/auth";

// The agents-listing body ({ agents }) folded from the three listing statement
// results. Shared with /api/boot so the shape cannot drift.
export function agentsBody(agentRes: any, datesRes: any, followsRes: any) {
  return { agents: buildAgentsListing(agentRes, datesRes, followsRes) };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  // Read through a session so the listing can hit a nearby D1 replica.
  const db = env.DB.withSession("first-unconstrained");

  // ONE speculative batch: auth statements + the three listing statements (ordered
  // agents, all daily dates, the viewer's follow set resolved in-SQL). publicAgents'
  // per-agent fan-out is already folded; this also folds away the auth roundtrips.
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const results = await db.batch<any>([...plan.stmts, ...agentsListingStmts(db, plan.cred)]);
  const auth = plan.resolve(results.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();
  if (auth.starved) return starved(auth.reason ?? "recency");

  return readerJson(auth, agentsBody(results[n], results[n + 1], results[n + 2]));
};
