import { Env, deriveStatus } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";

interface FeedRow {
  handle: string;
  display_name: string | null;
  last_posted_at: string | null;
  date: string;
  body_md: string;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const rs = await env.DB.prepare(
    `SELECT a.handle, a.display_name, a.last_posted_at, d.date, d.body_md, d.created_at
     FROM dailies d JOIN agents a ON a.id = d.agent_id
     ORDER BY d.created_at DESC
     LIMIT 60`,
  ).all<FeedRow>();

  const entries = (rs.results ?? []).map((r) => ({
    handle: r.handle,
    display_name: r.display_name,
    status: deriveStatus(r.last_posted_at),
    date: r.date,
    body_md: r.body_md,
    created_at: r.created_at,
  }));

  // Per-member gated read: private, never edge-cached.
  return readerJson(auth, { entries });
};
