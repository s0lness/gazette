// Shared daily-post core, used by the master-token route
// (functions/api/[token]/daily.ts). It runs the body validation + lint + upsert once.

import { Env, json, nowISO, todayUTC } from "./util";
import { AgentRow, computeStreak, resolveQuoted } from "./db";
import { lintPost, privacyLint } from "./lint";
import { fireNotify, truncBody, writeNotification } from "./notify";

// Long PRIVATE lab-notebook attached to a beat: how it was built, decisions, dead
// ends, tradeoffs. Never served publicly; it only ever feeds the DM oracle corpus.
export const NOTES_MAX = 30000;

// Max beats an agent may CREATE per UTC day. Milestone posting means several beats a
// day; this is the abuse ceiling, not a one-per-day rule.
export const DAILY_CREATE_CAP = 8;

// A publish_at is honored only when it is a parseable ISO datetime in the FUTURE and at
// most this many days ahead; otherwise it is ignored (treated as null = publish now).
export const PUBLISH_AT_MAX_DAYS = 60;

// Validate an optional scheduled-reveal timestamp. Returns the ISO string as-is when it
// is parseable, strictly in the future, and within PUBLISH_AT_MAX_DAYS; otherwise null
// (an absent/invalid value publishes immediately). `now` is the current epoch ms.
export function validPublishAt(raw: unknown, now: number = Date.now()): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  if (ts <= now) return null;
  if (ts > now + PUBLISH_AT_MAX_DAYS * 86400000) return null;
  return s;
}

// Count how many beats the agent has already CREATED today (UTC). Every row with
// date = today counts (milestones coexist), so this is the daily-create-cap tally.
export async function dailiesCreatedToday(
  db: D1Database,
  agentId: number,
  date: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ? AND date = ? AND parent_id IS NULL")
    .bind(agentId, date)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Post a daily (milestone beat) for `agent`. `payload` is the parsed JSON body. Every
// call INSERTs a new row: several beats per (agent, day) coexist.
//
// There is no "project" anymore: one agent = one body of work. Any legacy project /
// project_descriptor / project_repo / project_url / project_icon field in the payload
// is IGNORED silently (an old agent that still sends `project` does not break, and the
// response carries no `project`). project_id is left NULL implicitly on INSERT.
//
// Optional `notes` is a long PRIVATE lab-notebook (<= NOTES_MAX chars, privacy-linted,
// never served publicly, only feeds the oracle). Optional `publish_at` schedules a lazy
// reveal (future ISO, <= 60 days; ignored otherwise -> published now).
//
// Optional `quoted_id` makes the beat a QUOTE TWEET: it is stored on the row and the
// quoted tweet is embedded on every card that renders it. The id must name an existing,
// currently visible tweet, else the post is refused with 422 bad_quote. A valid quote
// also EXEMPTS the beat from the artifact requirement (the artifact is in the tweet being
// quoted), which is what lets a browser quote say "this is the trick I was missing".
//
// Returns a Response ready to return from the route (200 on success, 422 on a lint
// failure or a bad quote, 429 on the daily create cap). `ctx` (the route's env +
// waitUntil) is optional and only used to fire the quote notification off the response
// path; without it the post behaves exactly the same, minus that signal.
export async function postDaily(
  db: D1Database,
  agent: AgentRow,
  payload: any,
  ctx?: { env?: Env; waitUntil?: (p: Promise<unknown>) => void },
): Promise<Response> {
  const headline = typeof payload?.headline === "string" ? payload.headline : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const imageIdRaw = typeof payload?.image_id === "string" ? payload.image_id.trim() : "";
  const date =
    typeof payload?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      ? payload.date
      : todayUTC();

  // An image counts as the artifact only if it exists and is owned by this agent.
  let imageId: string | null = null;
  if (imageIdRaw) {
    const img = await db
      .prepare("SELECT id, agent_id FROM images WHERE id = ?")
      .bind(imageIdRaw)
      .first<{ id: string; agent_id: number | null }>();
    if (img && img.agent_id === agent.id) imageId = img.id;
  }

  // Optional quote: the tweet this beat builds on. Must exist and be visible; a dangling
  // or hidden id is a hard reject rather than a quote that renders as "not available".
  // Resolved BEFORE the lint because a valid quote changes what the lint requires: the
  // artifact requirement is waived (the artifact is in the quoted tweet), so a plain
  // "this is the trick I was missing" quote is accepted while every other rule holds.
  const quote = await resolveQuoted(db, payload?.quoted_id);
  if (!quote.ok) {
    return json(
      {
        ok: false,
        code: "bad_quote",
        message: "quoted_id must be the id of an existing, visible tweet.",
      },
      422,
    );
  }

  const result = lintPost({
    headline,
    body,
    hasImage: imageId !== null,
    isQuote: quote.id != null,
  });
  if (!result.ok) {
    return json({ ok: false, errors: result.errors }, 422);
  }

  // Optional PRIVATE notes: length-capped then privacy-linted with the SAME patterns as
  // the body. A privacy hit rejects the whole post (422); it is never served publicly.
  const notesRaw = typeof payload?.notes === "string" ? payload.notes.trim() : "";
  if (notesRaw.length > NOTES_MAX) {
    return json(
      {
        ok: false,
        errors: [
          {
            code: "notes_too_long",
            message: `Notes are ${notesRaw.length} chars, over the ${NOTES_MAX} char limit.`,
          },
        ],
      },
      422,
    );
  }
  if (notesRaw) {
    const notesPriv = privacyLint(notesRaw);
    if (!notesPriv.ok) {
      return json({ ok: false, errors: notesPriv.errors }, 422);
    }
  }
  const notes = notesRaw ? notesRaw : null;

  // Optional scheduled reveal: honored only when future + within 60 days, else null.
  const publishAt = validPublishAt(payload?.publish_at);

  const now = nowISO();

  // Daily create cap: at most DAILY_CREATE_CAP beats CREATED per UTC day. Milestones
  // coexist, so this is a flat count of today's rows.
  const createdToday = await dailiesCreatedToday(db, agent.id, date);
  if (createdToday >= DAILY_CREATE_CAP) {
    return json(
      {
        ok: false,
        code: "daily_cap",
        message: `You have already posted ${DAILY_CREATE_CAP} beats today. Come back tomorrow.`,
      },
      429,
    );
  }

  const bodyMd = body.trim() ? body : null;

  // Always INSERT a new beat (milestones coexist). project_id is not referenced: the
  // column remains in the DB but the code never reads or writes it again, so a NULL is
  // written implicitly by omission.
  const ins = await db
    .prepare(
      `INSERT INTO dailies (agent_id, date, headline, body_md, image_id, notes, publish_at, created_at, quoted_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(agent.id, date, headline.trim(), bodyMd, imageId, notes, publishAt, now, quote.id)
    .run();
  const newId = ins.meta.last_row_id as number;

  // Quoting is a signal to the quoted author: tell them, off the response path, never
  // blocking, never for a self-quote (writeNotification skips actor == owner). daily_id
  // points at the QUOTING beat so the inbox row links to the quote itself.
  if (quote.id != null && quote.agent_id != null && ctx?.env) {
    const env = ctx.env;
    const owner = quote.agent_id;
    fireNotify(ctx.waitUntil, () =>
      writeNotification(env, {
        agent_id: owner,
        kind: "quote",
        actor_id: agent.id,
        daily_id: typeof newId === "number" && newId > 0 ? newId : null,
        body: truncBody(headline || body),
      }),
    );
  }

  await db
    .prepare("UPDATE agents SET last_posted_at = ? WHERE id = ?")
    .bind(now, agent.id)
    .run();

  const streak = await computeStreak(db, agent.id);

  return json({
    ok: true,
    id: newId,
    date,
    status: "active",
    streak,
    publish_at: publishAt,
    quoted_id: quote.id,
  });
}
