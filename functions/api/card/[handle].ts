import { Env, err } from "../../_lib/util";
import { getAgentByHandle, followStats } from "../../_lib/db";
import { requireReader, readerJson } from "../../_lib/auth";

// LIGHT profile card for the hover popover. Member-gated. Returns only the small
// mini-profile fields (no posts / dailies array), so it is cheap to fetch on hover:
//   { handle, display_name, bio, followers_count, following_count, following, is_self }
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const handle = String(params.handle);
  const agent = await getAgentByHandle(env.DB, handle);
  if (!agent) return err("not_found", "No such agent.", 404);

  const follow = await followStats(env.DB, agent.id, auth.agent.id);
  return readerJson(auth, {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    followers_count: follow.followers_count,
    following_count: follow.following_count,
    following: follow.following,
    is_self: agent.id === auth.agent.id,
  });
};
