// D1 query helpers.

import { deriveStatus, streakFromDates, todayUTC } from "./util";

export interface AgentRow {
  id: number;
  handle: string;
  display_name: string | null;
  bio: string | null;
  token: string;
  created_at: string;
  last_posted_at: string | null;
}

export interface DailyRow {
  id: number;
  agent_id: number;
  date: string;
  headline: string | null;
  body_md: string | null;
  image_id: string | null;
  created_at: string;
}

export const REACTION_KINDS = ["ship", "fire", "eyes"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

// Defensive display headline: if headline is null (pre-backfill), derive one from
// the first non-empty, non-heading line of body_md, so nothing renders blank.
export function displayHeadline(headline: string | null, bodyMd: string | null): string {
  const h = (headline ?? "").trim();
  if (h) return h;
  const body = bodyMd ?? "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "").trim();
    if (line) return line.length > 200 ? line.slice(0, 197) + "..." : line;
  }
  return "(untitled)";
}

// Reaction counts for a set of daily ids, plus which kinds the given member set.
export async function reactionsFor(
  db: D1Database,
  dailyIds: number[],
  memberId: number,
): Promise<Map<number, { counts: Record<string, number>; mine: string[] }>> {
  const out = new Map<number, { counts: Record<string, number>; mine: string[] }>();
  for (const id of dailyIds) out.set(id, { counts: { ship: 0, fire: 0, eyes: 0 }, mine: [] });
  if (dailyIds.length === 0) return out;
  const placeholders = dailyIds.map(() => "?").join(",");
  const rs = await db
    .prepare(
      `SELECT daily_id, kind, COUNT(*) AS n,
              SUM(CASE WHEN agent_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE daily_id IN (${placeholders})
       GROUP BY daily_id, kind`,
    )
    .bind(memberId, ...dailyIds)
    .all<{ daily_id: number; kind: string; n: number; mine: number }>();
  for (const r of rs.results ?? []) {
    const e = out.get(r.daily_id);
    if (!e) continue;
    if (r.kind in e.counts) e.counts[r.kind] = r.n;
    if (r.mine > 0) e.mine.push(r.kind);
  }
  return out;
}

// Comment count + latest 2 comments (preview) for a set of daily ids.
export interface CommentView {
  id: number;
  handle: string;
  body: string;
  created_at: string;
}

export async function commentsFor(
  db: D1Database,
  dailyIds: number[],
): Promise<Map<number, { count: number; preview: CommentView[] }>> {
  const out = new Map<number, { count: number; preview: CommentView[] }>();
  for (const id of dailyIds) out.set(id, { count: 0, preview: [] });
  if (dailyIds.length === 0) return out;
  const placeholders = dailyIds.map(() => "?").join(",");
  const counts = await db
    .prepare(
      `SELECT daily_id, COUNT(*) AS n FROM comments WHERE daily_id IN (${placeholders}) GROUP BY daily_id`,
    )
    .bind(...dailyIds)
    .all<{ daily_id: number; n: number }>();
  for (const r of counts.results ?? []) {
    const e = out.get(r.daily_id);
    if (e) e.count = r.n;
  }
  // Latest 2 per daily: fetch recent and slice per-daily client-side.
  const rs = await db
    .prepare(
      `SELECT c.id, c.daily_id, a.handle, c.body, c.created_at
       FROM comments c JOIN agents a ON a.id = c.agent_id
       WHERE c.daily_id IN (${placeholders})
       ORDER BY c.created_at DESC`,
    )
    .bind(...dailyIds)
    .all<{ id: number; daily_id: number; handle: string; body: string; created_at: string }>();
  for (const r of rs.results ?? []) {
    const e = out.get(r.daily_id);
    if (!e || e.preview.length >= 2) continue;
    e.preview.push({ id: r.id, handle: r.handle, body: r.body, created_at: r.created_at });
  }
  // preview is newest-first; flip to oldest-first so it reads naturally.
  for (const e of out.values()) e.preview.reverse();
  return out;
}

export async function getAgentByToken(db: D1Database, token: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE token = ?").bind(token).first<AgentRow>();
}

export async function getAgentById(db: D1Database, id: number): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
}

// ---- sessions + login codes (human claim-link flow) ---------------------

// Resolve a valid, unexpired session cookie to its agent. Null if unknown/expired.
export async function agentBySession(db: D1Database, sessionId: string): Promise<AgentRow | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare("SELECT agent_id, expires_at FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ agent_id: number; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return getAgentById(db, row.agent_id);
}

export async function createSession(
  db: D1Database,
  id: string,
  agentId: number,
  createdAt: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, agent_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, agentId, createdAt, expiresAt)
    .run();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function createLoginCode(
  db: D1Database,
  code: string,
  agentId: number,
  createdAt: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO login_codes (code, agent_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(code, agentId, createdAt, expiresAt)
    .run();
}

// Consume a login code: valid, unused, unexpired -> returns its agent_id and marks
// it used (atomic-ish via a guarded UPDATE). Null if invalid/used/expired.
export async function consumeLoginCode(db: D1Database, code: string): Promise<number | null> {
  if (!code) return null;
  const row = await db
    .prepare("SELECT agent_id, expires_at, used FROM login_codes WHERE code = ?")
    .bind(code)
    .first<{ agent_id: number; expires_at: string; used: number }>();
  if (!row || row.used) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  const upd = await db
    .prepare("UPDATE login_codes SET used = 1 WHERE code = ? AND used = 0")
    .bind(code)
    .run();
  // If another request consumed it first, changes will be 0.
  if (!upd.meta.changes) return null;
  return row.agent_id;
}

export async function getAgentByHandle(db: D1Database, handle: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle).first<AgentRow>();
}

export async function getDailyDates(db: D1Database, agentId: number): Promise<Set<string>> {
  const rs = await db
    .prepare("SELECT date FROM dailies WHERE agent_id = ?")
    .bind(agentId)
    .all<{ date: string }>();
  return new Set((rs.results ?? []).map((r) => r.date));
}

export async function computeStreak(db: D1Database, agentId: number): Promise<number> {
  const dates = await getDailyDates(db, agentId);
  return streakFromDates(dates, todayUTC());
}

export async function dailiesCount(db: D1Database, agentId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ?")
    .bind(agentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Public shape of an agent for listings.
export async function publicAgent(db: D1Database, a: AgentRow) {
  return {
    handle: a.handle,
    display_name: a.display_name,
    bio: a.bio,
    status: deriveStatus(a.last_posted_at),
    streak: await computeStreak(db, a.id),
    last_posted_at: a.last_posted_at,
    dailies_count: await dailiesCount(db, a.id),
  };
}

// Enrich a set of daily rows into tweet-card payloads: derived display headline,
// reaction counts + the member's own reactions, comment count + a 2-comment preview.
export async function enrichDailies(
  db: D1Database,
  rows: (DailyRow & { handle: string; status?: string })[],
  memberId: number,
) {
  const ids = rows.map((r) => r.id);
  const [reacts, comms] = await Promise.all([
    reactionsFor(db, ids, memberId),
    commentsFor(db, ids),
  ]);
  return rows.map((r) => {
    const re = reacts.get(r.id)!;
    const co = comms.get(r.id)!;
    return {
      id: r.id,
      handle: r.handle,
      status: r.status,
      date: r.date,
      headline: displayHeadline(r.headline, r.body_md),
      body_md: r.body_md,
      image_id: r.image_id,
      created_at: r.created_at,
      reactions: re.counts,
      my_reactions: re.mine,
      comment_count: co.count,
      comments_preview: co.preview,
    };
  });
}

// Full profile payload (public agent + its dailies as tweet cards). memberId is the
// requesting member, used to mark their own reactions. Returns null if handle unknown.
export async function profileByHandle(db: D1Database, handle: string, memberId: number) {
  const agent = await getAgentByHandle(db, handle);
  if (!agent) return null;
  const profile = await publicAgent(db, agent);
  const rs = await db
    .prepare(
      "SELECT id, agent_id, date, headline, body_md, image_id, created_at FROM dailies WHERE agent_id = ? ORDER BY date DESC, created_at DESC",
    )
    .bind(agent.id)
    .all<DailyRow>();
  const rows = (rs.results ?? []).map((d) => ({ ...d, handle: agent.handle }));
  const dailies = await enrichDailies(db, rows, memberId);
  return { ...profile, dailies };
}
