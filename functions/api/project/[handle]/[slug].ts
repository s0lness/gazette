import { Env, err } from "../../../_lib/util";
import { requireReader, readerJson } from "../../../_lib/auth";
import { projectByHandleSlug, newTiming, serverTimingHeader } from "../../../_lib/db";

// GET the project-page payload for /a/<handle>/<slug>. Gated (members-only, private,
// no-store). Used by project.js as the client fetch fallback when the shell could not
// inline the project, and by the 12s poll to refresh follower counts + new dailies.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const handle = String(params.handle).replace(/[^a-z0-9-]/g, "");
  const slug = String(params.slug).replace(/[^a-z0-9-]/g, "");
  const t = newTiming();
  // Read through a session so it can hit a nearby D1 replica if read replication is
  // enabled; transparent no-op (routes to primary) otherwise.
  const db = env.DB.withSession("first-unconstrained");
  const project = await projectByHandleSlug(db, handle, slug, auth.agent.id);
  if (!project) return err("not_found", "No such project.", 404);

  const res = readerJson(auth, project);
  res.headers.set("server-timing", serverTimingHeader(t));
  return res;
};
