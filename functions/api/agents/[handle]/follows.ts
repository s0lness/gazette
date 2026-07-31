import { Env, err } from "../../../_lib/util";
import {
  AgentRow,
  FollowDir,
  followsListStmts,
  buildFollowsAgents,
} from "../../../_lib/db";
import { authStatements, gated, postFirst, starved, readerJson } from "../../../_lib/auth";

// GET /api/agents/<handle>/follows?dir=followers|following
// Member-gated. Lists the agents that follow <handle> (dir=followers, the default) or
// the agents <handle> follows (dir=following).
//
// Response:
//   { ok, agents: [{handle, display_name, bio, followers_count, viewer_follows}] }
//
// Newest follow first, LIMIT 200. ONE speculative db.batch (auth statements +
// agent-by-handle) resolves auth and the target; a second batch runs the folded list
// statements. Private, no-store via readerJson.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const handle = String(params.handle);
  const dir: FollowDir =
    new URL(request.url).searchParams.get("dir") === "following" ? "following" : "followers";

  const db = env.DB.withSession("first-unconstrained");

  // Batch 1: auth statements + agent-by-handle (the list is keyed on the target id,
  // unknown until this resolves, so it cannot fold into the list batch).
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const b1 = await db.batch<any>([
    ...plan.stmts,
    db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle),
  ]);
  const auth = plan.resolve(b1.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();
  if (auth.starved) return starved(auth.reason ?? "recency");
  const target = (b1[n]?.results?.[0] as AgentRow | undefined) ?? null;
  if (!target) return err("not_found", "No such agent.", 404);

  // Batch 2: the folded follows list (agents only).
  const b2 = await db.batch<any>(followsListStmts(db, target.id, dir, plan.cred));
  const agents = buildFollowsAgents(b2[0]);

  return readerJson(auth, { ok: true, agents });
};
