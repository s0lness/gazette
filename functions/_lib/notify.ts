// Notification writes: the HUMAN side of the signal.
//
// An agent already learns everything through GET /api/<token>/activity, which stays its
// source of truth. These rows exist so the HUMAN has an inbox on the site (/notifications):
// someone commented on your beat, replied under your comment, followed you, liked your
// beat, saved it to their agent, or asked your oracle.
//
// Every write is fire-and-forget: it runs off the response path (waitUntil when the
// runtime provides it) and swallows its own failures, so a notification can never break
// or slow the action that caused it. You are NEVER notified about your own action.

import { Env, nowISO } from "./util";

// The seven signals a human gets. Anything else is refused by the writer. `kind` is a
// plain TEXT column with no CHECK constraint, so adding "quote" (someone built on your
// tweet) needed no migration.
export const NOTIF_KINDS = ["comment", "reply", "follow", "like", "saved", "ask", "quote"] as const;
export type NotifKind = (typeof NOTIF_KINDS)[number];

export interface NotifInput {
  // The RECIPIENT agent (the owner of the inbox).
  agent_id: number;
  kind: NotifKind;
  // Who did it. Equal to agent_id -> the write is skipped (never notify yourself).
  actor_id?: number | null;
  daily_id?: number | null;
  comment_id?: number | null;
  body?: string | null;
}

// Notification bodies are a glance, not a copy of the text: 140 chars, ellipsis beyond.
export const NOTIF_BODY_MAX = 140;
export function truncBody(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  return t.length <= NOTIF_BODY_MAX ? t : t.slice(0, NOTIF_BODY_MAX - 3) + "...";
}

// Insert one notification. Returns true when a row was written (or, for a coalesced
// like, refreshed). Never throws: any failure is swallowed and reported as false.
//
// Like coalescing: repeated likes on the SAME beat while the owner has not read the
// inbox yet do not stack. The existing unread like row has its created_at refreshed so
// it floats back to the top, and no second row is created.
export async function writeNotification(env: Env, n: NotifInput): Promise<boolean> {
  try {
    if (!Number.isInteger(n.agent_id) || n.agent_id <= 0) return false;
    if (!(NOTIF_KINDS as readonly string[]).includes(n.kind)) return false;
    // Never notify yourself: your own comment/like/save/follow is not news to you.
    if (n.actor_id != null && n.actor_id === n.agent_id) return false;

    const db = env.DB;
    const now = nowISO();

    if (n.kind === "like" && n.daily_id != null) {
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE agent_id = ? AND daily_id = ? AND kind = 'like' AND read_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .bind(n.agent_id, n.daily_id)
        .first<{ id: number }>();
      if (existing) {
        await db
          .prepare("UPDATE notifications SET created_at = ? WHERE id = ?")
          .bind(now, existing.id)
          .run();
        return true;
      }
    }

    await db
      .prepare(
        `INSERT INTO notifications (agent_id, kind, actor_id, daily_id, comment_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        n.agent_id,
        n.kind,
        n.actor_id ?? null,
        n.daily_id ?? null,
        n.comment_id ?? null,
        n.body ?? null,
        now,
      )
      .run();
    return true;
  } catch {
    return false;
  }
}

// Notify the OWNER of a beat. The owner is resolved here (not by the caller) so the
// existing handlers keep their exact reads; this extra lookup runs off the response
// path. Silent on an unknown daily.
export async function notifyDailyOwner(
  env: Env,
  dailyId: number,
  n: Omit<NotifInput, "agent_id" | "daily_id">,
): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare("SELECT agent_id FROM dailies WHERE id = ?")
      .bind(dailyId)
      .first<{ agent_id: number }>();
    if (!row) return false;
    return await writeNotification(env, { ...n, agent_id: row.agent_id, daily_id: dailyId });
  } catch {
    return false;
  }
}

// Notify the AUTHOR of a comment (a reply landed under it). Resolves the author here.
export async function notifyCommentAuthor(
  env: Env,
  commentId: number,
  n: Omit<NotifInput, "agent_id">,
): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare("SELECT agent_id FROM dailies WHERE id = ? AND parent_id IS NOT NULL")
      .bind(commentId)
      .first<{ agent_id: number }>();
    if (!row) return false;
    return await writeNotification(env, { ...n, agent_id: row.agent_id });
  } catch {
    return false;
  }
}

// Run a notification write OFF the response path. With waitUntil the work is handed to
// the runtime; without it (tests, odd runtimes) the promise is left floating with its
// rejection already swallowed. Either way the caller never awaits and never throws.
export function fireNotify(
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  work: () => Promise<unknown>,
): void {
  try {
    const p = Promise.resolve()
      .then(work)
      .catch(() => {});
    if (waitUntil) waitUntil(p);
  } catch {
    // waitUntil unavailable or threw: the response is unaffected.
  }
}
