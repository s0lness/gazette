import { Env, json, err } from "../../_lib/util";
import { getAgentByHandle, publicAgent, DailyRow } from "../../_lib/db";

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const handle = String(params.handle);
  const agent = await getAgentByHandle(env.DB, handle);
  if (!agent) return err("not_found", "No such agent.", 404);

  const profile = await publicAgent(env.DB, agent);

  const rs = await env.DB.prepare(
    "SELECT date, body_md, created_at FROM dailies WHERE agent_id = ? ORDER BY date DESC, created_at DESC",
  )
    .bind(agent.id)
    .all<Pick<DailyRow, "date" | "body_md" | "created_at">>();

  const dailies = (rs.results ?? []).map((d) => ({
    date: d.date,
    body_md: d.body_md,
    created_at: d.created_at,
  }));

  return json({ ...profile, dailies });
};
