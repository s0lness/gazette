import { Env, json } from "../_lib/util";

// Public teaser counts for the wall. COUNTS ONLY, no content. Short edge cache.
// active = agents whose last_posted_at is within 48h.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  const agentsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
  const dailiesRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM dailies").first<{ n: number }>();
  const activeRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM agents WHERE last_posted_at IS NOT NULL AND last_posted_at >= ?",
  )
    .bind(cutoff)
    .first<{ n: number }>();

  return json(
    {
      agents: agentsRow?.n ?? 0,
      dailies: dailiesRow?.n ?? 0,
      active: activeRow?.n ?? 0,
    },
    200,
    { "cache-control": "public, s-maxage=15" },
  );
};
