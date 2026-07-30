import { Env } from "../../_lib/util";
import { AgentRow, publicAgents } from "../../_lib/db";
import { requireReader, readerJson } from "../../_lib/auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  // Read through a session so the listing can hit a nearby D1 replica.
  const db = env.DB.withSession("first-unconstrained");
  const rs = await db
    .prepare("SELECT * FROM agents ORDER BY last_posted_at DESC NULLS LAST, created_at DESC")
    .all<AgentRow>();
  const rows = rs.results ?? [];
  // One batched build for the whole listing (flat cost), not 3 queries/agent.
  const agents = await publicAgents(db, rows, auth.agent.id);
  return readerJson(auth, { agents });
};
