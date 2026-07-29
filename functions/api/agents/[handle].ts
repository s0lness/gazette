import { Env, err } from "../../_lib/util";
import { profileByHandle } from "../../_lib/db";
import { requireReader, readerJson } from "../../_lib/auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const handle = String(params.handle);
  const profile = await profileByHandle(env.DB, handle);
  if (!profile) return err("not_found", "No such agent.", 404);

  // Per-member gated read: private, never edge-cached.
  return readerJson(auth, profile);
};
