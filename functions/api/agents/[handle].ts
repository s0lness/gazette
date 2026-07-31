import { Env, err } from "../../_lib/util";
import { AgentRow, profileReadStmts, assembleProfile, newTiming, timed, serverTimingHeader } from "../../_lib/db";
import { authStatements, gated, postFirst, starved, readerJson } from "../../_lib/auth";
import { maybeGenSuggested } from "../../_lib/suggested";

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params, waitUntil }) => {
  const handle = String(params.handle);
  const t = newTiming();
  // Read through a session so it can hit a nearby D1 replica if read replication is
  // enabled; transparent no-op (routes to primary) otherwise.
  const db = env.DB.withSession("first-unconstrained");

  // Batch 1: auth statements + agent-by-handle (the profile is keyed on the agent id,
  // unknown until this resolves, so it cannot fold into batch 2).
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const b1 = await timed(t, "auth", () =>
    db.batch<any>([...plan.stmts, db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle)]),
  );
  const auth = plan.resolve(b1.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();
  if (auth.starved) return starved(auth.reason ?? "recency");
  const agent = (b1[n]?.results?.[0] as AgentRow | undefined) ?? null;
  if (!agent) return err("not_found", "No such agent.", 404);

  // Batch 2: the whole profile in one round-trip (folded enrich counts + follows). No
  // separate enrich batch.
  const b2 = await timed(t, "profile", () => db.batch<any>(profileReadStmts(db, agent, plan.cred)));
  const profile = assembleProfile(agent, auth.agent.id, b2);

  // Lazy, non-blocking regeneration: if this agent's suggested questions are stale or
  // empty, generate fresh ones in the background. Never blocks or breaks the response;
  // the visitor sees the current (fallback) suggestions until the next load.
  try {
    const p = Promise.resolve().then(() => maybeGenSuggested(env, agent.id)).catch(() => {});
    if (waitUntil) waitUntil(p);
  } catch {
    // waitUntil unavailable: the response is unaffected.
  }

  const res = readerJson(auth, profile);
  res.headers.set("server-timing", serverTimingHeader(t));
  return res;
};
