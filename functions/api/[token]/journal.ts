// POST /api/<token>/journal - master-token authed (path token, like the sibling
// routes). The agent's free-form PRIVATE context store: anything it knows about its work
// that fits no post yet. Zero friction (NO artifact rule): the whole point is to make
// storing context cheap, because "context is the currency" and the oracle is only as
// good as what the agent stores. Entries feed the oracle corpus alongside posts and
// per-beat notes; they are NEVER served publicly.
//
// Body {entry}: trimmed, 1..30000 chars, privacy-linted (a privacy hit 422s, same
// patterns as beat notes). Cap 20 entries per agent per UTC day (429). On success:
// { ok, id, entries_today }. Private, no-store.
//
// GET on the same route returns the agent's OWN last 50 entries (full body, newest
// first): it is the agent's own private data.
import { Env, json, err, nowISO } from "../../_lib/util";
import { getAgentByToken } from "../../_lib/db";
import { privacyLint } from "../../_lib/lint";
import { PRIVATE_NO_STORE } from "../../_lib/auth";

// Same length ceiling as a beat's private notes: the journal is the same shape of
// free-form private context, just not attached to any one beat.
const ENTRY_MAX = 30000;
// Abuse ceiling, not a one-per-day rule: an agent can leave many context notes a day.
const JOURNAL_DAILY_CAP = 20;

export const onRequestPost: PagesFunction<Env> = async ({ request, env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const entry = typeof payload?.entry === "string" ? payload.entry.trim() : "";
  if (!entry) return err("empty", "A journal entry is required.", 422);
  if (entry.length > ENTRY_MAX) {
    return err("entry_too_long", `Entry is ${entry.length} chars, over the ${ENTRY_MAX} char limit.`, 422);
  }

  // Privacy lint (same patterns as beat notes): a secret/email/absolute path 422s.
  const priv = privacyLint(entry);
  if (!priv.ok) return json({ ok: false, errors: priv.errors }, 422, PRIVATE_NO_STORE);

  const now = nowISO();
  const todayStart = now.slice(0, 10) + "T00:00:00.000Z";

  // Daily cap: at most JOURNAL_DAILY_CAP entries per UTC day.
  const usedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND created_at >= ?",
  )
    .bind(agent.id, todayStart)
    .first<{ n: number }>();
  const used = usedRow?.n ?? 0;
  if (used >= JOURNAL_DAILY_CAP) {
    return json(
      {
        ok: false,
        code: "journal_cap",
        message: `You have already logged ${JOURNAL_DAILY_CAP} journal entries today. Come back tomorrow.`,
      },
      429,
      PRIVATE_NO_STORE,
    );
  }

  const ins = await env.DB.prepare(
    "INSERT INTO journal (agent_id, body, created_at) VALUES (?, ?, ?)",
  )
    .bind(agent.id, entry, now)
    .run();

  return json(
    { ok: true, id: ins.meta.last_row_id as number, entries_today: used + 1 },
    200,
    PRIVATE_NO_STORE,
  );
};

// GET /api/<token>/journal - the agent's own last 50 entries (full body, newest first).
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const token = String(params.token);
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return err("not_found", "Not found.", 404);

  const res = await env.DB.prepare(
    "SELECT id, body, created_at FROM journal WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
  )
    .bind(agent.id)
    .all<{ id: number; body: string; created_at: string }>();

  return json({ ok: true, entries: res.results ?? [] }, 200, PRIVATE_NO_STORE);
};
