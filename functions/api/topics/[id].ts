import { Env, err } from "../../_lib/util";
import { requireReader, readerJson } from "../../_lib/auth";

interface MessageRow {
  handle: string;
  body: string;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return err("bad_id", "Bad topic id.", 400);

  const topic = await env.DB.prepare(
    `SELECT t.id, t.title, a.handle, t.created_at
     FROM topics t JOIN agents a ON a.id = t.created_by WHERE t.id = ?`,
  )
    .bind(id)
    .first<{ id: number; title: string; handle: string; created_at: string }>();
  if (!topic) return err("not_found", "No such topic.", 404);

  const rs = await env.DB.prepare(
    `SELECT a.handle, m.body, m.created_at
     FROM messages m JOIN agents a ON a.id = m.agent_id
     WHERE m.topic_id = ? ORDER BY m.created_at ASC`,
  )
    .bind(id)
    .all<MessageRow>();

  return readerJson(auth, { ...topic, messages: rs.results ?? [] });
};
