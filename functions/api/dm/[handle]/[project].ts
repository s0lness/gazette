import { Env, json, err, nowISO, todayUTC, sha256Hex } from "../../../_lib/util";
import { getAgentByHandle } from "../../../_lib/db";
import { authMember, gated, postFirst, readerJson, authStatements, PRIVATE_NO_STORE } from "../../../_lib/auth";
import {
  DM_SALT,
  buildCorpus,
  askOracle,
  hasVerbatimRun,
  cleanAnswer,
  VERBATIM_REFUSAL,
  DailyLite,
  ChatTurn,
} from "../../../_lib/dm";

// Per (member, project, UTC day) message cap. The oracle is a multi-turn chat now.
const DAILY_MESSAGES = 10;
// IP-level backstop across all agents.
const IP_DAILY_CAP = 60;
// How many recent turns to replay as context.
const HISTORY_TURNS = 12;

// PROJECT-SCOPED ask: mirrors functions/api/dm/[handle].ts, but the corpus is one
// project's dailies and the system prompt scopes the oracle to that project. Quota is
// per (member, project, UTC day) via a scoped visitor_hash, without a schema change.
export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  // Members-only: must be logged in and have posted a daily.
  const member = await authMember(env, request);
  if (!member) return gated();
  if (!member.canRead) return postFirst();
  const requester = member.agent;

  const handle = String(params.handle);
  const slug = String(params.project);
  const agent = await getAgentByHandle(env.DB, handle);
  if (!agent) return err("not_found", "No such agent.", 404);

  // Resolve the project by (agent_id, slug); 404 if unknown.
  const project = await env.DB.prepare(
    "SELECT id, name, slug, descriptor FROM projects WHERE agent_id = ? AND slug = ?",
  )
    .bind(agent.id, slug)
    .first<{ id: number; name: string; slug: string; descriptor: string | null }>();
  if (!project) return err("not_found", "No such project.", 404);

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (!question) return err("empty", "A question is required.", 422);
  if (question.length > 1000) return err("too_long", "Question is over 1000 chars.", 422);

  // Quota identity is scoped to this project: 10 messages per (requester, project, day).
  // This is separate from the global agent ask ("member:" + requester.id), so a member
  // gets 10/day for the builder AND 10/day per project, all under the same 60/day/IP cap.
  const visitorHash = "member:" + requester.id + ":p" + project.id;
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await sha256Hex(ip + "|" + DM_SALT);

  const date = todayUTC();
  const db = env.DB;

  // The oracle call dominates, so fold the four pre-oracle reads (quota COUNT,
  // IP-backstop COUNT, project corpus, history) into ONE batch, then gate in order.
  const [usedRes, ipRes, corpusRes, histRes] = await db.batch<any>([
    db
      .prepare("SELECT COUNT(*) AS n FROM dm_log WHERE visitor_hash = ? AND agent_id = ? AND date = ?")
      .bind(visitorHash, agent.id, date),
    db.prepare("SELECT COUNT(*) AS n FROM dm_log WHERE ip_hash = ? AND date = ?").bind(ipHash, date),
    db
      .prepare(
        "SELECT date, headline, body_md FROM dailies WHERE agent_id = ? AND project_id = ? ORDER BY date DESC, created_at DESC",
      )
      .bind(agent.id, project.id),
    db
      .prepare(
        "SELECT question, answer FROM dm_log WHERE visitor_hash = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(visitorHash, agent.id, HISTORY_TURNS),
  ]);

  // Quota: 10 messages per (requesting member, project, UTC day).
  const used = (usedRes?.results?.[0]?.n as number) ?? 0;
  if (used >= DAILY_MESSAGES) {
    return json(
      { code: "quota", message: "That's our 10 messages for today. Come back tomorrow." },
      429,
      PRIVATE_NO_STORE,
    );
  }

  // IP-level backstop: cap total questions from one IP across all agents at 60/day.
  if (((ipRes?.results?.[0]?.n as number) ?? 0) >= IP_DAILY_CAP) {
    return json(
      { code: "quota", message: "That's our 10 messages for today. Come back tomorrow." },
      429,
      PRIVATE_NO_STORE,
    );
  }

  // API key must be present.
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { code: "dm_unavailable", message: "The oracle is still warming up. Give it a minute." },
      503,
      PRIVATE_NO_STORE,
    );
  }

  // Build corpus from THIS PROJECT's dailies only, most recent first.
  const dailies = (corpusRes?.results ?? []) as DailyLite[];
  const corpus = buildCorpus(dailies);

  // Last 12 turns (newest first), reversed to oldest-first for askOracle to replay.
  const history = ((histRes?.results ?? []) as ChatTurn[]).slice().reverse();

  const outcome = await askOracle(
    env.ANTHROPIC_API_KEY,
    handle,
    corpus,
    question,
    { name: project.name, descriptor: project.descriptor },
    history,
  );
  if (!outcome.ok) {
    // API failure: do not burn quota, log nothing.
    return json(
      { code: "dm_unavailable", message: "The oracle is still warming up. Give it a minute." },
      503,
      PRIVATE_NO_STORE,
    );
  }

  // Hard no-dash guarantee, applied BEFORE the verbatim check and before logging.
  let answer = cleanAnswer(outcome.answer!);
  // Output filter: reject 12-word verbatim runs. Still counts quota.
  if (hasVerbatimRun(answer, corpus, 12)) {
    answer = VERBATIM_REFUSAL;
  }

  await db
    .prepare(
      "INSERT INTO dm_log (agent_id, visitor_hash, ip_hash, date, question, answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(agent.id, visitorHash, ipHash, date, question, answer, nowISO())
    .run();

  return json({ answer, remaining: DAILY_MESSAGES - used - 1 }, 200, PRIVATE_NO_STORE);
};

// Load the viewer's conversation with this project (the project-scoped thread), oldest
// first. Member-gated. ONE speculative batch: auth statements + agent-by-handle +
// project-by-(handle,slug) + the history read (its agent_id, project id and
// visitor_hash all resolved in-SQL, so nothing depends on an id we do not yet have).
export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const handle = String(params.handle);
  const slug = String(params.project);
  const db = env.DB;
  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const c = plan.cred;

  const VIEWER_ID =
    "(SELECT id FROM agents WHERE token = ?1 UNION ALL SELECT agent_id FROM sessions WHERE id = ?2 AND expires_at > ?3 LIMIT 1)";
  // The project id resolved from (handle, slug), reused in the history filter.
  const PROJ_ID =
    "(SELECT p.id FROM projects p JOIN agents a ON a.id = p.agent_id WHERE a.handle = ?4 AND p.slug = ?5)";

  const results = await db.batch<any>([
    ...plan.stmts,
    db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle),
    db
      .prepare("SELECT p.id FROM projects p JOIN agents a ON a.id = p.agent_id WHERE a.handle = ? AND p.slug = ?")
      .bind(handle, slug),
    db
      .prepare(
        `SELECT question, answer, created_at FROM dm_log
         WHERE visitor_hash = ('member:' || ${VIEWER_ID} || ':p' || ${PROJ_ID})
           AND agent_id = (SELECT id FROM agents WHERE handle = ?4)
         ORDER BY created_at ASC LIMIT 200`,
      )
      .bind(c.token, c.sid, c.now, handle, slug),
  ]);

  const auth = plan.resolve(results.slice(0, n));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();
  const agent = results[n]?.results?.[0];
  if (!agent) return err("not_found", "No such agent.", 404);
  const project = results[n + 1]?.results?.[0];
  if (!project) return err("not_found", "No such project.", 404);

  return readerJson(auth, { ok: true, messages: results[n + 2]?.results ?? [] });
};
