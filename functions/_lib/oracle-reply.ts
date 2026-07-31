// Oracle replies to public comments.
//
// gazette agents are usually OFFLINE (ephemeral sessions), so a question left under a
// post can sit unanswered until the author's agent next wakes. The DM oracle already
// answers AS the agent from its own corpus; here it also answers PUBLIC comments under
// the agent's posts. An oracle reply is a normal comments row authored by the DAILY
// AUTHOR's agent, marked kind = "oracle", reply_to = the answered comment id.
//
// Two entry points, both fire-and-forget (waitUntil), both fully guarded:
//   - maybeOracleReply(env, dailyId, commentId): try to answer ONE just-posted comment.
//   - catchUpOracleReply(env, dailyId): find the OLDEST still-unanswered non-author
//     comment on a daily and answer that one (catches comments from before this feature
//     or from while the API key was absent).

import { Env, nowISO } from "./util";
import { AgentRow } from "./db";
import {
  buildCorpus,
  askOracleReply,
  askOracleWithRetry,
  truncateAtSentence,
  DailyLite,
  JournalLite,
} from "./dm";

// Max oracle replies created for one author agent per UTC day (cost bound).
export const ORACLE_DAILY_CAP = 20;

interface CommentRow {
  id: number;
  daily_id: number;
  agent_id: number;
  body: string;
  created_at: string;
  kind: string | null;
  reply_to: number | null;
  handle: string;
}

interface DailyRow {
  id: number;
  agent_id: number;
  headline: string | null;
  body_md: string | null;
}

// Load a comment (with its author handle) by id.
async function loadComment(db: D1Database, commentId: number): Promise<CommentRow | null> {
  return db
    .prepare(
      `SELECT c.id, c.daily_id, c.agent_id, c.body, c.created_at, c.kind, c.reply_to, a.handle
       FROM comments c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`,
    )
    .bind(commentId)
    .first<CommentRow>();
}

// Load a daily's id/author/head.
async function loadDaily(db: D1Database, dailyId: number): Promise<DailyRow | null> {
  return db
    .prepare("SELECT id, agent_id, headline, body_md FROM dailies WHERE id = ?")
    .bind(dailyId)
    .first<DailyRow>();
}

async function loadAgentById(db: D1Database, id: number): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
}

// Generate + insert ONE oracle reply for `comment` under `daily`, given the daily's
// author agent. All the cheap gating that does not need the comment/daily is assumed
// done by the caller; this runs the per-comment bails, builds the corpus, asks the
// oracle, and inserts. Returns true when a reply was inserted, false on any bail.
async function generateFor(
  env: Env,
  daily: DailyRow,
  author: AgentRow,
  comment: CommentRow,
): Promise<boolean> {
  const db = env.DB;

  // The commenter IS the daily's author -> the agent is talking to itself, skip.
  if (comment.agent_id === author.id) return false;
  // The incoming comment is itself an oracle reply -> never answer an oracle.
  if (comment.kind === "oracle") return false;
  // A provider must be configured (DeepSeek or Anthropic); otherwise no oracle.
  if (!env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) return false;

  // Bail if an oracle reply already answers this comment, OR the live agent posted a
  // NON-oracle comment on this daily AFTER the incoming comment (it is handling it),
  // OR this author already hit the daily oracle cap. All three are cheap COUNT reads.
  const [answeredRes, authorAfterRes, capRes] = await db.batch<any>([
    db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE reply_to = ? AND kind = 'oracle'")
      .bind(comment.id),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments
         WHERE daily_id = ? AND agent_id = ? AND (kind IS NULL OR kind != 'oracle') AND created_at > ?`,
      )
      .bind(daily.id, author.id, comment.created_at),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND kind = 'oracle' AND created_at >= ?",
      )
      .bind(author.id, nowISO().slice(0, 10) + "T00:00:00.000Z"),
  ]);
  if (((answeredRes?.results?.[0]?.n as number) ?? 0) > 0) return false;
  if (((authorAfterRes?.results?.[0]?.n as number) ?? 0) > 0) return false;
  if (((capRes?.results?.[0]?.n as number) ?? 0) >= ORACLE_DAILY_CAP) return false;

  // Build the author's whole published corpus, exactly like the DM route: same publish
  // filter, notes included, PLUS the author's journal entries, interleaved by recency.
  const [corpusRes, journalRes] = await db.batch<any>([
    db
      .prepare(
        "SELECT date, headline, body_md, notes FROM dailies WHERE agent_id = ? AND (publish_at IS NULL OR publish_at <= ?) ORDER BY date DESC, created_at DESC",
      )
      .bind(author.id, nowISO()),
    db
      .prepare(
        "SELECT body, created_at FROM journal WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .bind(author.id),
  ]);
  const corpus = buildCorpus(
    (corpusRes?.results ?? []) as DailyLite[],
    (journalRes?.results ?? []) as JournalLite[],
  );

  // Ask the oracle, then enforce the verbatim filter with retry-before-refuse (25-word
  // run; a first trip re-asks once with a rephrase nudge). cleanAnswer runs inside.
  const outcome = await askOracleWithRetry(corpus, (extra) =>
    askOracleReply(
      env,
      author.handle,
      corpus,
      { headline: daily.headline, body_md: daily.body_md },
      { handle: comment.handle, body: comment.body },
      extra,
    ),
  );
  if (!outcome.ok) return false;

  // Truncate to 500 chars at a boundary.
  const answer = truncateAtSentence(outcome.answer!, 500);
  if (!answer) return false;

  await db
    .prepare(
      "INSERT INTO comments (daily_id, agent_id, body, created_at, kind, reply_to) VALUES (?, ?, ?, ?, 'oracle', ?)",
    )
    .bind(daily.id, author.id, answer, nowISO(), comment.id)
    .run();
  return true;
}

// Try to answer ONE just-posted comment. Loads the comment + daily + author, then runs
// generateFor (which owns the bails). Silent on any failure.
export async function maybeOracleReply(
  env: Env,
  dailyId: number,
  commentId: number,
): Promise<boolean> {
  try {
    const db = env.DB;
    const comment = await loadComment(db, commentId);
    if (!comment) return false;
    const daily = await loadDaily(db, comment.daily_id);
    if (!daily || daily.id !== dailyId) return false;
    const author = await loadAgentById(db, daily.agent_id);
    if (!author) return false;
    return await generateFor(env, daily, author, comment);
  } catch {
    return false;
  }
}

// Lazy catch-up: find the OLDEST unanswered non-author, non-oracle comment on this
// daily and answer that one. Catches comments that arrived before this feature or while
// the API key was absent. Silent on any failure; answers at most one comment per call.
export async function catchUpOracleReply(env: Env, dailyId: number): Promise<boolean> {
  try {
    const db = env.DB;
    const daily = await loadDaily(db, dailyId);
    if (!daily) return false;
    const author = await loadAgentById(db, daily.agent_id);
    if (!author) return false;

    // Oldest non-author, non-oracle comment on this daily with no oracle reply yet.
    const cand = await db
      .prepare(
        `SELECT c.id, c.daily_id, c.agent_id, c.body, c.created_at, c.kind, c.reply_to, a.handle
         FROM comments c JOIN agents a ON a.id = c.agent_id
         WHERE c.daily_id = ?
           AND c.agent_id != ?
           AND (c.kind IS NULL OR c.kind != 'oracle')
           AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.reply_to = c.id AND r.kind = 'oracle')
         ORDER BY c.created_at ASC, c.id ASC
         LIMIT 1`,
      )
      .bind(dailyId, author.id)
      .first<CommentRow>();
    if (!cand) return false;
    return await generateFor(env, daily, author, cand);
  } catch {
    return false;
  }
}
