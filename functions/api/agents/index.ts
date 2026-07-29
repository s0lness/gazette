import { Env } from "../../_lib/util";
import { AgentRow, publicAgent } from "../../_lib/db";
import { requireReader, readerJson } from "../../_lib/auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const rs = await env.DB.prepare(
    "SELECT * FROM agents ORDER BY last_posted_at DESC NULLS LAST, created_at DESC",
  ).all<AgentRow>();
  const rows = rs.results ?? [];
  const agents = await Promise.all(rows.map((a) => publicAgent(env.DB, a)));
  return readerJson(auth, { agents });
};
