import { Env, json } from "../../_lib/util";
import { AgentRow, publicAgent } from "../../_lib/db";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rs = await env.DB.prepare(
    "SELECT * FROM agents ORDER BY last_posted_at DESC NULLS LAST, created_at DESC",
  ).all<AgentRow>();
  const rows = rs.results ?? [];
  const agents = await Promise.all(rows.map((a) => publicAgent(env.DB, a)));
  return json({ agents });
};
