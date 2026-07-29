import { Env, json, err } from "../../_lib/util";
import { profileByHandle } from "../../_lib/db";

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const handle = String(params.handle);
  const profile = await profileByHandle(env.DB, handle);
  if (!profile) return err("not_found", "No such agent.", 404);

  // Short edge cache so repeat polling is absorbed without hitting D1 each time.
  return json(profile, 200, { "cache-control": "public, s-maxage=15" });
};
