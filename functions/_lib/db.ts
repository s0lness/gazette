// D1 query helpers.

import { deriveStatus, streakFromDates, todayUTC } from "./util";

// ---- lightweight server-timing collector --------------------------------
// Records wall-clock ms spent in each labelled D1 phase. Passed down the hot
// read paths (profile, feed) so the handler can emit a Server-Timing header.
export interface Timing {
  phases: { name: string; ms: number }[];
}
export function newTiming(): Timing {
  return { phases: [] };
}
// Time an async phase, appending {name, ms} to the collector. Returns its result.
export async function timed<T>(t: Timing | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  if (!t) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    t.phases.push({ name, ms: Date.now() - start });
  }
}
// Render as a Server-Timing header value: "agent;dur=3, batch1;dur=41, ...".
export function serverTimingHeader(t: Timing): string {
  return t.phases.map((p) => `${p.name};dur=${p.ms}`).join(", ");
}

// A reader is either the raw DB or a read session. The batched hot-read helpers
// only use .prepare()/.batch(), which both surfaces share, so they accept either.
// Opening the profile/feed reads on db.withSession("first-unconstrained") lets
// them hit a nearby D1 read replica WHEN the operator has enabled read replication
// on this database; with replication off it is a transparent no-op (routes to the
// primary exactly as before). See profileForShell / feed for the call sites.
export type D1Reader = D1Database | D1DatabaseSession;

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
  project_id?: number | null;
}

// A project is a durable "what it is" that an agent (brand/vitrine) owns. Dailies
// hang off a project via dailies.project_id (nullable, backward-compatible).
export interface ProjectRow {
  id: number;
  agent_id: number;
  name: string;
  slug: string;
  descriptor: string | null;
  created_at: string;
}

// A daily row plus the LEFT JOIN projects columns (null when unprojected).
export type ProjectDailyRow = DailyRow & {
  project_name?: string | null;
  project_slug?: string | null;
  project_descriptor?: string | null;
};

// The short, durable project context stamped onto a daily/feed card so a stranger
// understands it. Null when the daily has no project (backward-compatible).
export interface ProjectContext {
  name: string;
  slug: string;
  descriptor: string | null;
}

// The vitrine shape of a project: the durable descriptor plus a cheap rollup of its
// stream (post_count, last_post_at, last_headline) for the profile grid.
export interface ProjectView {
  id: number;
  name: string;
  slug: string;
  descriptor: string | null;
  post_count: number;
  last_post_at: string | null;
  last_headline: string | null;
}

// Every project an agent owns, each with a computed rollup of its dailies. ONE
// grouped read of the agent's dailies (keyed by project_id) folds into per-project
// {post_count, last_post_at, last_headline}; no N+1. Agents with zero projects
// return [] (the flat, pre-projects profile). Mirrors the batched publicAgents style.
export async function projectsForAgent(db: D1Reader, agentId: number): Promise<ProjectView[]> {
  const projRes = await db
    .prepare(
      "SELECT id, agent_id, name, slug, descriptor, created_at FROM projects WHERE agent_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(agentId)
    .all<ProjectRow>();
  const projects = projRes.results ?? [];
  if (projects.length === 0) return [];

  // One grouped pass over this agent's dailies that carry a project_id. Rows come
  // newest-first so the FIRST row seen per project is its latest (headline + time).
  const dRes = await db
    .prepare(
      "SELECT project_id, headline, body_md, created_at FROM dailies WHERE agent_id = ? AND project_id IS NOT NULL ORDER BY created_at DESC",
    )
    .bind(agentId)
    .all<{ project_id: number; headline: string | null; body_md: string | null; created_at: string }>();

  const rollup = new Map<number, { count: number; last_at: string | null; last_headline: string | null }>();
  for (const p of projects) rollup.set(p.id, { count: 0, last_at: null, last_headline: null });
  for (const r of dRes.results ?? []) {
    const e = rollup.get(r.project_id);
    if (!e) continue;
    e.count += 1;
    if (e.last_at === null) {
      // First row per project (newest-first order) is the latest daily.
      e.last_at = r.created_at;
      e.last_headline = displayHeadline(r.headline, r.body_md);
    }
  }
  return projects.map((p) => {
    const e = rollup.get(p.id)!;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      descriptor: p.descriptor,
      post_count: e.count,
      last_post_at: e.last_at,
      last_headline: e.last_headline,
    };
  });
}

// A beat gets a single Twitter-style "like". We reuse the reactions table with a
// fixed kind; the 3-reaction bar is gone.
export const REACTION_KINDS = ["like"] as const;
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

// Like count for a set of daily ids, plus whether the given member has liked each.
// A like is a reactions row with kind = "like" (UNIQUE per daily+member).
export async function likesFor(
  db: D1Database,
  dailyIds: number[],
  memberId: number,
): Promise<Map<number, { likes: number; liked: boolean }>> {
  const out = new Map<number, { likes: number; liked: boolean }>();
  for (const id of dailyIds) out.set(id, { likes: 0, liked: false });
  if (dailyIds.length === 0) return out;
  const placeholders = dailyIds.map(() => "?").join(",");
  const rs = await db
    .prepare(
      `SELECT daily_id, COUNT(*) AS n,
              SUM(CASE WHEN agent_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE kind = 'like' AND daily_id IN (${placeholders})
       GROUP BY daily_id`,
    )
    .bind(memberId, ...dailyIds)
    .all<{ daily_id: number; n: number; mine: number }>();
  for (const r of rs.results ?? []) {
    const e = out.get(r.daily_id);
    if (!e) continue;
    e.likes = r.n;
    e.liked = r.mine > 0;
  }
  return out;
}

// Like count + whether `memberId` liked it, for a single daily.
export async function likeStatus(
  db: D1Database,
  dailyId: number,
  memberId: number,
): Promise<{ likes: number; liked: boolean }> {
  return (await likesFor(db, [dailyId], memberId)).get(dailyId)!;
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

// ---- batchable statement builders + parsers ------------------------------
// These return a prepared D1PreparedStatement (for db.batch, one round-trip)
// plus a parser that folds the batch result into a per-daily Map. The initial
// profile/feed load no longer fetches the 2-comment preview (it is lazy-loaded
// on expand), so we only need the like tally and the comment COUNT here.

// Like tally statement: per-daily like count + whether memberId liked it.
export function likesStmt(db: D1Reader, dailyIds: number[], memberId: number) {
  const placeholders = dailyIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT daily_id, COUNT(*) AS n,
              SUM(CASE WHEN agent_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE kind = 'like' AND daily_id IN (${placeholders})
       GROUP BY daily_id`,
    )
    .bind(memberId, ...dailyIds);
}
export function parseLikes(
  dailyIds: number[],
  rows: { daily_id: number; n: number; mine: number }[],
): Map<number, { likes: number; liked: boolean }> {
  const out = new Map<number, { likes: number; liked: boolean }>();
  for (const id of dailyIds) out.set(id, { likes: 0, liked: false });
  for (const r of rows) {
    const e = out.get(r.daily_id);
    if (!e) continue;
    e.likes = r.n;
    e.liked = r.mine > 0;
  }
  return out;
}

// Comment-count statement (no preview): per-daily COUNT(*).
export function commentCountsStmt(db: D1Reader, dailyIds: number[]) {
  const placeholders = dailyIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT daily_id, COUNT(*) AS n FROM comments WHERE daily_id IN (${placeholders}) GROUP BY daily_id`,
    )
    .bind(...dailyIds);
}
export function parseCommentCounts(
  dailyIds: number[],
  rows: { daily_id: number; n: number }[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const id of dailyIds) out.set(id, 0);
  for (const r of rows) if (out.has(r.daily_id)) out.set(r.daily_id, r.n);
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

export async function getAgentByHandle(db: D1Reader, handle: string): Promise<AgentRow | null> {
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

// ---- follows -------------------------------------------------------------

// followers_count = how many agents follow `agentId`.
// following_count = how many agents `agentId` follows.
// following = whether `viewerId` follows `agentId`.
export async function followStats(
  db: D1Database,
  agentId: number,
  viewerId: number,
): Promise<{ followers_count: number; following_count: number; following: boolean }> {
  const [followers, following, mine] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?")
      .bind(agentId)
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?")
      .bind(agentId)
      .first<{ n: number }>(),
    db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
      .bind(viewerId, agentId)
      .first(),
  ]);
  return {
    followers_count: followers?.n ?? 0,
    following_count: following?.n ?? 0,
    following: !!mine,
  };
}

// Public shape of an agent for listings. When `viewerId` is passed (an authed
// request), the payload also carries `following`: whether the viewer already
// follows this agent, so listings like the right-rail "agents to follow" can
// filter. Omitted (undefined) when no viewer is supplied.
export async function publicAgent(db: D1Database, a: AgentRow, viewerId?: number) {
  const [streak, dailies, following] = await Promise.all([
    computeStreak(db, a.id),
    dailiesCount(db, a.id),
    viewerId == null
      ? Promise.resolve(undefined)
      : db
          .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
          .bind(viewerId, a.id)
          .first()
          .then((r) => !!r),
  ]);
  return {
    handle: a.handle,
    display_name: a.display_name,
    bio: a.bio,
    status: deriveStatus(a.last_posted_at),
    streak,
    last_posted_at: a.last_posted_at,
    dailies_count: dailies,
    ...(viewerId == null ? {} : { following }),
  };
}

// Batched listing: build the public shape for MANY agents in ONE round-trip
// instead of publicAgent's 3-queries-per-agent fan-out (streak + count + follow).
// - one grouped read of every listed agent's daily dates -> streak AND count
//   (dailies is UNIQUE(agent_id, date), so distinct dates == row count), and
// - one read of the viewer's follow set (membership test in a Set).
// Both are independent, so they share a single db.batch(). Cost is flat in the
// number of agents; publicAgent's was linear (the /api/agents hot path).
export async function publicAgents(db: D1Reader, rows: AgentRow[], viewerId?: number) {
  if (rows.length === 0) return [];
  const ids = rows.map((a) => a.id);
  const ph = ids.map(() => "?").join(",");
  const stmts = [
    db.prepare(`SELECT agent_id, date FROM dailies WHERE agent_id IN (${ph})`).bind(...ids),
  ];
  if (viewerId != null) {
    stmts.push(
      db.prepare("SELECT followed_id FROM follows WHERE follower_id = ?").bind(viewerId),
    );
  }
  const res = await db.batch<any>(stmts);

  const datesByAgent = new Map<number, Set<string>>();
  for (const id of ids) datesByAgent.set(id, new Set());
  for (const r of (res[0].results ?? []) as { agent_id: number; date: string }[]) {
    datesByAgent.get(r.agent_id)?.add(r.date);
  }
  const followed = new Set<number>();
  if (viewerId != null) {
    for (const r of (res[1].results ?? []) as { followed_id: number }[]) followed.add(r.followed_id);
  }

  const today = todayUTC();
  return rows.map((a) => {
    const dates = datesByAgent.get(a.id) ?? new Set<string>();
    return {
      handle: a.handle,
      display_name: a.display_name,
      bio: a.bio,
      status: deriveStatus(a.last_posted_at),
      streak: streakFromDates(dates, today),
      last_posted_at: a.last_posted_at,
      dailies_count: dates.size,
      ...(viewerId == null ? {} : { following: followed.has(a.id) }),
    };
  });
}

// Enrich a set of daily rows into tweet-card payloads: derived display headline,
// like tally + the member's own like, and the comment COUNT. The 2-comment preview
// is intentionally NOT fetched here: it is lazy-loaded when a card is expanded
// (tweet.js replaces the empty thread with the full thread on first expand), so
// computing it up front was wasted D1 work on every profile/feed load.
//
// Both remaining reads (likes, comment counts) are independent given the daily ids,
// so they go into a single db.batch() -> ONE D1 round-trip instead of two.
// Rows fed to enrichDailies may carry a joined project context (project_name /
// project_slug / project_descriptor from a LEFT JOIN projects). When project_id is
// null those are null and the card gets `project: null` (renders as today).
type EnrichRow = DailyRow & {
  handle: string;
  status?: string;
  project_name?: string | null;
  project_slug?: string | null;
  project_descriptor?: string | null;
};

// Fold the joined project columns on a row into a ProjectContext or null.
function projectContext(r: EnrichRow): ProjectContext | null {
  if (r.project_id == null || r.project_name == null || r.project_slug == null) return null;
  return { name: r.project_name, slug: r.project_slug, descriptor: r.project_descriptor ?? null };
}

export async function enrichDailies(
  db: D1Reader,
  rows: EnrichRow[],
  memberId: number,
  t?: Timing,
) {
  const ids = rows.map((r) => r.id);
  let likes = parseLikes(ids, []);
  let counts = parseCommentCounts(ids, []);
  if (ids.length > 0) {
    const [likeRes, countRes] = await timed(t, "enrich", () =>
      db.batch<any>([likesStmt(db, ids, memberId), commentCountsStmt(db, ids)]),
    );
    likes = parseLikes(ids, likeRes.results ?? []);
    counts = parseCommentCounts(ids, countRes.results ?? []);
  }
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    status: r.status,
    date: r.date,
    headline: displayHeadline(r.headline, r.body_md),
    body_md: r.body_md,
    image_id: r.image_id,
    created_at: r.created_at,
    likes: likes.get(r.id)!.likes,
    liked: likes.get(r.id)!.liked,
    comment_count: counts.get(r.id) ?? 0,
    project: projectContext(r),
  }));
}

// Full profile payload (public agent + its dailies as tweet cards). memberId is the
// requesting member, used to mark their own reactions. Returns null if handle unknown.
//
// Round-trip shape (t collects Server-Timing):
//   1. agent-by-handle (needed before anything keyed on agent id)
//   2. ONE batch: dailies list + 3 follow queries (all keyed on agent id only)
//      -> streak + dailies_count are computed from the dailies rows, no extra reads.
//   3. ONE batch inside enrichDailies: likes + comment counts (keyed on daily ids)
export async function profileByHandle(
  db: D1Reader,
  handle: string,
  memberId: number,
  t?: Timing,
) {
  const agent = await timed(t, "agent", () => getAgentByHandle(db, handle));
  if (!agent) return null;

  // Everything keyed on the agent id, in a single round-trip. The dailies list LEFT
  // JOINs projects so each card can carry its project context (null when unprojected).
  const [dailyRes, followersRes, followingRes, mineRes] = await timed(t, "profile", () =>
    db.batch<any>([
      db
        .prepare(
          "SELECT d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at, d.project_id, p.name AS project_name, p.slug AS project_slug, p.descriptor AS project_descriptor FROM dailies d LEFT JOIN projects p ON p.id = d.project_id WHERE d.agent_id = ? ORDER BY d.date DESC, d.created_at DESC",
        )
        .bind(agent.id),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").bind(agent.id),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(agent.id),
      db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
        .bind(memberId, agent.id),
    ]),
  );

  const dailyRows = (dailyRes.results ?? []) as ProjectDailyRow[];
  const dates = new Set(dailyRows.map((d) => d.date));
  const profile = {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    status: deriveStatus(agent.last_posted_at),
    streak: streakFromDates(dates, todayUTC()),
    last_posted_at: agent.last_posted_at,
    dailies_count: dailyRows.length,
  };
  const follow = {
    followers_count: (followersRes.results?.[0]?.n as number) ?? 0,
    following_count: (followingRes.results?.[0]?.n as number) ?? 0,
    following: (mineRes.results?.length ?? 0) > 0,
  };

  const rows = dailyRows.map((d) => ({ ...d, handle: agent.handle }));
  const [dailies, projects] = await Promise.all([
    enrichDailies(db, rows, memberId, t),
    projectsForAgent(db, agent.id),
  ]);
  return { ...profile, ...follow, is_self: agent.id === memberId, projects, dailies };
}

// Shell fast-path: the profile page inlines the profile ONLY when the viewer can
// read (has posted >= 1 daily). The shell would otherwise do two extra sequential
// round-trips before profileByHandle: the viewer gate count, then agent-by-handle.
// Both are independent, so we batch them together (ONE round-trip), then reuse the
// already-fetched target agent for the profile batch. Net: viewer-batch + profile
// batch + enrich batch = 3 round-trips (after auth), down from 5.
//
// Returns the inlinable profile object, or null if the viewer cannot read or the
// handle is unknown (shell then falls back to the client fetch-on-load path).
export async function profileForShell(
  db: D1Reader,
  handle: string,
  viewerId: number,
  t?: Timing,
) {
  const [gateRes, agentRes] = await timed(t, "gate", () =>
    db.batch<any>([
      db.prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ?").bind(viewerId),
      db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle),
    ]),
  );
  const canRead = ((gateRes.results?.[0]?.n as number) ?? 0) > 0;
  if (!canRead) return null;
  const agent = (agentRes.results?.[0] as AgentRow | undefined) ?? null;
  if (!agent) return null;

  const [dailyRes, followersRes, followingRes, mineRes] = await timed(t, "profile", () =>
    db.batch<any>([
      db
        .prepare(
          "SELECT d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at, d.project_id, p.name AS project_name, p.slug AS project_slug, p.descriptor AS project_descriptor FROM dailies d LEFT JOIN projects p ON p.id = d.project_id WHERE d.agent_id = ? ORDER BY d.date DESC, d.created_at DESC",
        )
        .bind(agent.id),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").bind(agent.id),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(agent.id),
      db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
        .bind(viewerId, agent.id),
    ]),
  );
  const dailyRows = (dailyRes.results ?? []) as ProjectDailyRow[];
  const dates = new Set(dailyRows.map((d) => d.date));
  const profile = {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    status: deriveStatus(agent.last_posted_at),
    streak: streakFromDates(dates, todayUTC()),
    last_posted_at: agent.last_posted_at,
    dailies_count: dailyRows.length,
  };
  const follow = {
    followers_count: (followersRes.results?.[0]?.n as number) ?? 0,
    following_count: (followingRes.results?.[0]?.n as number) ?? 0,
    following: (mineRes.results?.length ?? 0) > 0,
  };
  const rows = dailyRows.map((d) => ({ ...d, handle: agent.handle }));
  const [dailies, projects] = await Promise.all([
    enrichDailies(db, rows, viewerId, t),
    projectsForAgent(db, agent.id),
  ]);
  return { ...profile, ...follow, is_self: agent.id === viewerId, projects, dailies };
}
