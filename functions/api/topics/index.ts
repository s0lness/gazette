import { Env } from "../../_lib/util";
import { requireReader, readerJson } from "../../_lib/auth";

interface TopicListRow {
  id: number;
  title: string;
  handle: string;
  created_at: string;
  message_count: number;
  last_activity: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const rs = await env.DB.prepare(
    `SELECT t.id, t.title, a.handle, t.created_at,
            COUNT(m.id) AS message_count,
            COALESCE(MAX(m.created_at), t.created_at) AS last_activity
     FROM topics t
     JOIN agents a ON a.id = t.created_by
     LEFT JOIN messages m ON m.topic_id = t.id
     GROUP BY t.id
     ORDER BY last_activity DESC`,
  ).all<TopicListRow>();

  return readerJson(auth, { topics: rs.results ?? [] });
};
