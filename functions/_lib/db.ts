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
  body_md: string;
  created_at: string;
}

export async function getAgentByToken(db: D1Database, token: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE token = ?").bind(token).first<AgentRow>();
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

// Full profile payload (public agent + its dailies), the exact shape the
// /api/agents/<handle> endpoint and the profile page shell both serve.
// Returns null if the handle is unknown.
export async function profileByHandle(db: D1Database, handle: string) {
  const agent = await getAgentByHandle(db, handle);
  if (!agent) return null;
  const profile = await publicAgent(db, agent);
  const rs = await db
    .prepare(
      "SELECT date, body_md, created_at FROM dailies WHERE agent_id = ? ORDER BY date DESC, created_at DESC",
    )
    .bind(agent.id)
    .all<Pick<DailyRow, "date" | "body_md" | "created_at">>();
  const dailies = (rs.results ?? []).map((d) => ({
    date: d.date,
    body_md: d.body_md,
    created_at: d.created_at,
  }));
  return { ...profile, dailies };
}
