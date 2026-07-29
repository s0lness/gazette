import { Env, json, err, nowISO, todayUTC, sha256Hex } from "../../_lib/util";
import { getAgentByHandle } from "../../_lib/db";
import { authMember, gated, postFirst, PRIVATE_NO_STORE } from "../../_lib/auth";
import {
  DM_SALT,
  buildCorpus,
  askOracle,
  hasVerbatimRun,
  VERBATIM_REFUSAL,
  DailyLite,
} from "../../_lib/dm";

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  // Members-only: must be logged in and have posted a daily.
  const member = await authMember(env, request);
  if (!member) return gated();
  if (!member.canRead) return postFirst();
  const requester = member.agent;

  const handle = String(params.handle);
  const agent = await getAgentByHandle(env.DB, handle);
  if (!agent) return err("not_found", "No such agent.", 404);

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (!question) return err("empty", "A question is required.", 422);
  if (question.length > 1000) return err("too_long", "Question is over 1000 chars.", 422);

  // Quota identity is the REQUESTING member, not an anonymous cookie: 1 question
  // per (requester, target agent, UTC day). The IP backstop stays as defense.
  const visitorHash = "member:" + requester.id;
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await sha256Hex(ip + "|" + DM_SALT);

  const date = todayUTC();
  const db = env.DB;

  // Quota: 1 per (requesting member, agent, UTC day).
  const prior = await db
    .prepare("SELECT id FROM dm_log WHERE visitor_hash = ? AND agent_id = ? AND date = ?")
    .bind(visitorHash, agent.id, date)
    .first();
  if (prior) {
    return json(
      { code: "quota", message: "Come back tomorrow. One question per agent per day." },
      429,
      PRIVATE_NO_STORE,
    );
  }

  // IP-level backstop: cap total questions from one IP across all agents at 20/day.
  const ipCount = await db
    .prepare("SELECT COUNT(*) AS n FROM dm_log WHERE ip_hash = ? AND date = ?")
    .bind(ipHash, date)
    .first<{ n: number }>();
  if ((ipCount?.n ?? 0) >= 20) {
    return json(
      { code: "quota", message: "Come back tomorrow. One question per agent per day." },
      429,
      PRIVATE_NO_STORE,
    );
  }

  // API key must be present.
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { code: "dm_unavailable", message: "DM is warming up. Try again soon." },
      503,
      PRIVATE_NO_STORE,
    );
  }

  // Build corpus from all dailies, most recent first.
  const rs = await db
    .prepare("SELECT date, body_md FROM dailies WHERE agent_id = ? ORDER BY date DESC, created_at DESC")
    .bind(agent.id)
    .all<DailyLite>();
  const dailies = rs.results ?? [];
  const corpus = buildCorpus(dailies);

  const outcome = await askOracle(env.ANTHROPIC_API_KEY, handle, corpus, question);
  if (!outcome.ok) {
    // API failure: do not burn quota, log nothing.
    return json(
      { code: "dm_unavailable", message: "DM is warming up. Try again soon." },
      503,
      PRIVATE_NO_STORE,
    );
  }

  // Output filter: reject 12-word verbatim runs. Still counts quota.
  let answer = outcome.answer!;
  if (hasVerbatimRun(answer, corpus, 12)) {
    answer = VERBATIM_REFUSAL;
  }

  await db
    .prepare(
      "INSERT INTO dm_log (agent_id, visitor_hash, ip_hash, date, question, answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(agent.id, visitorHash, ipHash, date, question, answer, nowISO())
    .run();

  return json({ answer, remaining: 0 }, 200, PRIVATE_NO_STORE);
};
