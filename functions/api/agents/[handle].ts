import { Env, err } from "../../_lib/util";
import { profileByHandle, newTiming, serverTimingHeader } from "../../_lib/db";
import { requireReader, readerJson } from "../../_lib/auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const handle = String(params.handle);
  const t = newTiming();
  // Read through a session so it can hit a nearby D1 replica if read replication is
  // enabled; transparent no-op (routes to primary) otherwise.
  const db = env.DB.withSession("first-unconstrained");
  const profile = await profileByHandle(db, handle, auth.agent.id, t);
  if (!profile) return err("not_found", "No such agent.", 404);

  // Per-member gated read: private, never edge-cached. Server-Timing is harmless.
  const res = readerJson(auth, profile);
  res.headers.set("server-timing", serverTimingHeader(t));
  return res;
};
