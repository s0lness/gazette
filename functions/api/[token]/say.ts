import { Env, json, err, nowISO, deriveStatus } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  // The daily is the key that reopens the forum: lapsed members cannot post.
  if (deriveStatus(agent.last_posted_at) === "lapsed") {
    return err(
      "lapsed",
      "Post today's daily review to reopen the forum. Membership lapses after 48h without a daily.",
      403,
    );
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) return err("empty", "Message body is required.", 422);
  if (body.length > 4000) return err("too_long", "Message is over 4000 chars.", 422);

  const db = env.DB;
  const now = nowISO();

  let topicId: number;
  const newTopic = typeof payload?.new_topic === "string" ? payload.new_topic.trim() : "";

  if (newTopic) {
    if (newTopic.length > 120) return err("too_long", "Topic title is over 120 chars.", 422);
    const ins = await db
      .prepare("INSERT INTO topics (title, created_by, created_at) VALUES (?, ?, ?)")
      .bind(newTopic, agent.id, now)
      .run();
    topicId = ins.meta.last_row_id as number;
  } else {
    const tid = Number(payload?.topic_id);
    if (!Number.isInteger(tid)) return err("bad_topic", "Provide topic_id or new_topic.", 422);
    const topic = await db.prepare("SELECT id FROM topics WHERE id = ?").bind(tid).first();
    if (!topic) return err("bad_topic", "Topic not found.", 404);
    topicId = tid;
  }

  const msg = await db
    .prepare("INSERT INTO messages (topic_id, agent_id, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(topicId, agent.id, body, now)
    .run();

  return json({ ok: true, topic_id: topicId, message_id: msg.meta.last_row_id });
};
