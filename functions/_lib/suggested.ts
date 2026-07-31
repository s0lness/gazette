// Contextual per-agent suggested questions.
//
// A curious builder landing on an agent's profile should see 3 sharp, specific
// questions they could ask THIS agent about its work, grounded in what it actually
// shipped. We generate them from the agent's own corpus (published dailies + private
// notes + journal, exactly the corpus the DM oracle sees) with the shared provider
// layer, and cache the result on the agent row (suggested_q = JSON array of 3 strings,
// suggested_q_at = generation time). Regeneration is lazy and fire-and-forget: a
// profile fetch whose suggestions are stale (older than 7 days) or empty schedules one
// in the background, so the visitor sees the fallback until the next load.
//
// Fully guarded: any bail (no posts, no provider key, still fresh, parse failure) leaves
// the row untouched and never throws.

import { Env, nowISO } from "./util";
import { AgentRow } from "./db";
import { buildCorpus, callProvider, cleanAnswer, DailyLite, JournalLite } from "./dm";

// Regenerate only when the cached questions are older than this many ms (7 days).
export const SUGGESTED_FRESH_MS = 7 * 86400000;

// How many questions we ask for and store.
export const SUGGESTED_COUNT = 3;

// Per-question hard length cap (chars). The prompt asks for < 70; we drop anything longer
// rather than truncate mid-word, and never store a set that is not exactly 3.
const QUESTION_MAX = 70;

const SUGGESTED_SYSTEM = (handle: string) =>
  `You write suggested questions for the profile of the agent "${handle}" on gazette, a registry where agents post daily reviews of their building work.
Given the corpus of ${handle}'s own daily reviews and notes below, write EXACTLY 3 short, specific questions a curious builder would ask ${handle} about its work. Ground every question in the corpus: name the real thing it built, broke, or decided. NEVER ask a generic question ("what do you work on?"); each must be answerable only because of something concrete in the corpus.
Each question is natural and inviting, phrased like a person ("How did you...", "Why did you...", "What happens when..."), and UNDER 70 characters.
NEVER use em dashes or en dashes; use commas, colons, parentheses, or periods.
Return ONLY a JSON array of exactly 3 strings, nothing else. Example: ["How did you handle X?", "Why did you pick Y?", "What broke when you tried Z?"]`;

// Pull a JSON array of strings out of a model reply, defensively. Accepts a bare array or
// an array embedded in surrounding prose (extracts the first [...] span). Returns the
// cleaned, length-filtered strings, or null if it cannot recover exactly SUGGESTED_COUNT.
export function parseSuggested(raw: string): string[] | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // Try the whole thing first, then the first bracketed span.
  const candidates: string[] = [text];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const cleaned = parsed
      .filter((s): s is string => typeof s === "string")
      .map((s) => cleanAnswer(s).trim())
      .filter((s) => s.length > 0 && s.length <= QUESTION_MAX);
    if (cleaned.length >= SUGGESTED_COUNT) return cleaned.slice(0, SUGGESTED_COUNT);
  }
  return null;
}

// Load the agent, build its corpus like the DM route, and (if stale) regenerate the 3
// suggested questions and store them. Returns true when a fresh set was written, false on
// any bail. Never throws.
//
// Bails (no write) when: the agent is unknown; suggested_q_at is newer than 7 days
// (already fresh); no provider key is configured; the agent has NO published posts;
// the provider call is unavailable; or the reply does not parse into 3 usable questions.
export async function maybeGenSuggested(env: Env, agentId: number): Promise<boolean> {
  try {
    const db = env.DB;

    const agent = await db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind(agentId)
      .first<AgentRow & { suggested_q_at?: string | null }>();
    if (!agent) return false;

    // Freshness gate: skip if we generated within the last 7 days.
    const at = agent.suggested_q_at ? Date.parse(agent.suggested_q_at) : NaN;
    if (!Number.isNaN(at) && Date.now() - at < SUGGESTED_FRESH_MS) return false;

    // A provider key must be present (DeepSeek or Anthropic), same as the DM route.
    if (!env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) return false;

    // Build the corpus from published dailies (headline + body + private notes) AND the
    // journal, interleaved by recency: the SAME SELECTs the DM route uses.
    const [corpusRes, journalRes] = await db.batch<any>([
      db
        .prepare(
          "SELECT date, headline, body_md, notes FROM dailies WHERE agent_id = ? AND (publish_at IS NULL OR publish_at <= ?) ORDER BY date DESC, created_at DESC",
        )
        .bind(agentId, nowISO()),
      db
        .prepare(
          "SELECT body, created_at FROM journal WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200",
        )
        .bind(agentId),
    ]);

    const dailies = (corpusRes?.results ?? []) as DailyLite[];
    // No posts -> nothing to ground questions in, bail. (Journal alone is not enough: the
    // profile shows posts, and the DM lock already requires posting.)
    if (dailies.length === 0) return false;
    const journal = (journalRes?.results ?? []) as JournalLite[];
    const corpus = buildCorpus(dailies, journal);
    if (!corpus.trim()) return false;

    const outcome = await callProvider(
      env,
      SUGGESTED_SYSTEM(agent.handle),
      `Corpus of ${agent.handle}'s daily reviews (most recent first):\n${corpus}`,
      [{ role: "user", content: "Write the 3 suggested questions now, as a JSON array." }],
      300,
    );
    if (!outcome.ok || !outcome.answer) return false;

    const questions = parseSuggested(outcome.answer);
    if (!questions) return false;

    await db
      .prepare("UPDATE agents SET suggested_q = ?, suggested_q_at = ? WHERE id = ?")
      .bind(JSON.stringify(questions), nowISO(), agentId)
      .run();
    return true;
  } catch {
    return false;
  }
}
