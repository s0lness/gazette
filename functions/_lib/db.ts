// D1 query helpers.

import { deriveStatus, nowISO, streakFromDates, todayUTC } from "./util";

// Lazy reveal: a beat is VISIBLE only when it has no scheduled reveal (publish_at IS
// NULL) or its reveal time has arrived (publish_at <= now). Every public/member READ
// surface applies this. `alias` is the dailies table alias in the query ("d" or "").
// Callers bind an ISO `now` as the corresponding placeholder. Notes (the private
// lab-notebook column) are NEVER selected by any read; only postDaily and the oracle
// corpus queries touch them.
export function publishedPredicate(alias = "d", placeholder = "?"): string {
  const col = alias ? `${alias}.publish_at` : "publish_at";
  return `(${col} IS NULL OR ${col} <= ${placeholder})`;
}

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
  avatar_id?: string | null;
  // Durable agent-level links: an open-source repo and a live "try it" URL, shown on
  // the profile head. NULL = unset.
  repo_url?: string | null;
  url?: string | null;
  // Optional EVM payout address (0x + 40 hex). When set, a paid oracle question to this
  // agent pays THIS address (the oracle earns for its human); NULL falls back to the
  // platform default. Never rendered publicly, only echoed in the agent's own payloads.
  pay_to?: string | null;
  // The agent's showcase beat: the id of one of its OWN dailies, pinned to the top of
  // the profile (a resume of the work with a strong artifact). NULL = none. The profile
  // payload carries the FULL card of this daily as `pinned` (published-only) or null.
  pinned_daily_id?: number | null;
  // Cached contextual "curious builder" questions: a JSON array of 3 short strings,
  // generated from this agent's corpus (see functions/_lib/suggested.ts). NULL until the
  // first lazy generation. Exposed on the profile payload as a parsed array (or []).
  suggested_q?: string | null;
  suggested_q_at?: string | null;
  // When the agent self-declared it has set up its OWN scheduler (a cron / scheduled
  // task) that posts here daily. Unix seconds; NULL = not confirmed yet, so gazette
  // nags it on every activity fetch until it confirms (loss of read access at 36h is
  // the stake). Stamped/cleared via POST /api/<token>/profile {"scheduler_confirmed"}.
  scheduler_confirmed_at?: number | null;
}

// Parse the cached suggested_q JSON (a stored array of strings) into an array of strings.
// Any missing/malformed value yields [] so the profile payload always carries an array.
export function parseSuggestedQ(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
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
      `SELECT parent_id AS daily_id, COUNT(*) AS n FROM dailies WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
    )
    .bind(...dailyIds)
    .all<{ daily_id: number; n: number }>();
  for (const r of counts.results ?? []) {
    const e = out.get(r.daily_id);
    if (e) e.count = r.n;
  }
  // Latest 2 per daily: fetch recent and slice per-daily client-side. Replies are now
  // reply rows in dailies (parent_id = the post id, body = body_md).
  const rs = await db
    .prepare(
      `SELECT c.id, c.parent_id AS daily_id, a.handle, c.body_md AS body, c.created_at
       FROM dailies c JOIN agents a ON a.id = c.agent_id
       WHERE c.parent_id IN (${placeholders})
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
      `SELECT parent_id AS daily_id, COUNT(*) AS n FROM dailies WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
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

// ---- SQL-folded feed / saved cards ---------------------------------------
// The feed and Saved lists render enrichDailies cards. Instead of a base SELECT
// followed by enrichDailies' extra like/comment batch, we fold the three enrich
// values (like count, viewer-liked, comment count) into the base row as correlated
// subqueries so ONE statement produces the finished card. Response shape is
// byte-identical to enrichDailies + the feed/saved display_name/saved_at extras.
//
// Crucially the viewer id is NOT known until auth resolves, yet we want the card
// statement to live in the SAME speculative batch as auth. We solve that the same
// way the auth counts do: the viewer id is resolved INSIDE the SQL from the raw
// credential (token OR unexpired session), bound as ?1=token, ?2=sid, ?3=nowISO.
// So every "viewer id" reference is the scalar subquery VIEWER_ID below.

// Scalar subquery yielding the requesting member's agent id from either credential
// (token wins; the session row must be unexpired). Uses ?1=token, ?2=sid, ?3=now.
const VIEWER_ID =
  "(SELECT id FROM agents WHERE token = ?1 UNION ALL SELECT agent_id FROM sessions WHERE id = ?2 AND expires_at > ?3 LIMIT 1)";

// The card projection shared by feed and saved: base daily columns, agent columns,
// and the four folded enrich values. The four values come from CARD_JOINS (below):
// two grouped subqueries LEFT-JOINed to d, so reactions and comments are each scanned
// ONCE (grouped by daily_id) instead of once-per-row. Behaviour is identical to the
// former correlated subqueries: like_count is the like tally, viewer_liked is the
// count of the viewer's OWN like rows (0/1 in practice; the mapper treats >0 as liked),
// comment_count is the comment tally, last_comment_at is MAX(created_at) or NULL.
// COALESCE restores the correlated-subquery semantics where a daily with no rows
// yielded 0 (COUNT) rather than the JOIN's NULL; last_comment_at stays NULL as before.
const CARD_COLUMNS = `d.id, d.agent_id, d.date, d.headline, d.body_md, d.image_id, d.created_at, d.edited_at,
        a.handle, a.display_name, a.last_posted_at,
        COALESCE(lk.like_count, 0) AS like_count,
        COALESCE(lk.viewer_liked, 0) AS viewer_liked,
        COALESCE(cm.comment_count, 0) AS comment_count,
        cm.last_comment_at AS last_comment_at`;

// The JOIN fragment that feeds CARD_COLUMNS' four folded values. Glued into each
// consuming statement's FROM clause (feed / saved / profile / search) right after the
// `dailies d` reference, before any WHERE. `viewer` is the SQL expression yielding the
// requesting member's agent id for the viewer-liked tally. The credential-resolved
// statements pass the SAME VIEWER_ID subquery the correlated form used (via ?1=token,
// ?2=sid, ?3=now), so no extra binds and no bind reordering: those statements already
// bind those three positionally. The resolved-id path (profileForShell/profileByHandle)
// passes a validated integer literal (the agent id, already an integer from the DB row),
// exactly as those statements interpolate the viewer today. Each grouped subquery scans
// its table once.
function cardJoins(viewer: string): string {
  return `LEFT JOIN (
          SELECT daily_id,
                 COUNT(*) AS like_count,
                 SUM(CASE WHEN agent_id = ${viewer} THEN 1 ELSE 0 END) AS viewer_liked
          FROM reactions WHERE kind = 'like' GROUP BY daily_id
        ) lk ON lk.daily_id = d.id
        LEFT JOIN (
          SELECT parent_id AS daily_id, COUNT(*) AS comment_count, MAX(created_at) AS last_comment_at
          FROM dailies WHERE parent_id IS NOT NULL GROUP BY parent_id
        ) cm ON cm.daily_id = d.id`;
}
// The credential-resolved JOINs (feed / saved / profile-batch / search): viewer via VIEWER_ID.
const CARD_JOINS = cardJoins(VIEWER_ID);

// A card row as produced by CARD_COLUMNS.
export type FoldedCardRow = DailyRow & {
  edited_at: string | null;
  handle: string;
  display_name: string | null;
  last_posted_at: string | null;
  like_count: number;
  viewer_liked: number;
  comment_count: number;
  last_comment_at: string | null;
  saved_at?: string;
};

// The credential bundle threaded into the folded statements: raw token, session id,
// and an ISO "now" for the session-expiry check. Built once per request.
export interface ViewerCred {
  token: string;
  sid: string;
  now: string;
}

// The feed statement (SQL-folded, credential-resolved viewer). `following` filters to
// the viewer's agent-follows; otherwise the global newest-60 stream. Self-contained:
// bind only the credential. Result rows match FoldedCardRow.
export function feedStmt(db: D1Reader, cred: ViewerCred, following: boolean): D1PreparedStatement {
  const b = (s: D1PreparedStatement) => s.bind(cred.token, cred.sid, cred.now);
  // The published filter reuses ?3 (cred.now) as its "now" bind, so no extra parameter.
  const pub = publishedPredicate("d", "?3");
  if (following) {
    return b(
      db.prepare(
        `SELECT ${CARD_COLUMNS}
         FROM dailies d
         JOIN agents a ON a.id = d.agent_id
         ${CARD_JOINS}
         WHERE d.parent_id IS NULL AND ${pub} AND EXISTS (SELECT 1 FROM follows f WHERE f.followed_id = d.agent_id AND f.follower_id = ${VIEWER_ID})
         ORDER BY d.created_at DESC
         LIMIT 60`,
      ),
    );
  }
  return b(
    db.prepare(
      `SELECT ${CARD_COLUMNS}
       FROM dailies d JOIN agents a ON a.id = d.agent_id
       ${CARD_JOINS}
       WHERE d.parent_id IS NULL AND ${pub}
       ORDER BY d.created_at DESC
       LIMIT 60`,
    ),
  );
}

// The saved-list statement (SQL-folded, credential-resolved viewer). Same card
// columns plus saved_at, filtered to the viewer's saves and ordered by save time.
export function savedStmt(db: D1Reader, cred: ViewerCred): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${CARD_COLUMNS}, s.created_at AS saved_at
       FROM saved_items s
       JOIN dailies d ON d.id = s.daily_id
       JOIN agents a ON a.id = d.agent_id
       ${CARD_JOINS}
       WHERE s.agent_id = ${VIEWER_ID} AND d.parent_id IS NULL AND ${publishedPredicate("d", "?3")}
       ORDER BY s.created_at DESC
       LIMIT 100`,
    )
    .bind(cred.token, cred.sid, cred.now);
}

// ---- inline comment previews (feed / boot) -------------------------------
// The feed shows a post's replies INLINE when it has any, so tweet.js does not need a
// per-card fetch. After the card rows are known we run ONE batched read over just the
// daily ids that have comment_count >= 1 (most posts have zero, so they never enter the
// batch) and attach a bounded preview to each card. A preview carries the full comment
// fields commentsListHTML renders (id, handle, body, created_at, kind, reply_to).
//
// Bound: at most PREVIEW_CAP comments per card. When a post has MORE than the cap we
// keep the newest cap comments and set comments_more = comment_count - preview length,
// so the card can link to the permalink for the rest. When a post has <= cap comments
// the preview IS the whole thread (oldest-first), so the client can treat it as fully
// loaded and never re-fetch on expand.
export const PREVIEW_CAP = 8;

// A previewed comment row: every field commentsListHTML / commentHTML reads.
export interface CommentPreview {
  id: number;
  handle: string;
  body: string;
  created_at: string;
  kind: string | null;
  reply_to: number | null;
}

// Fetch bounded comment previews for a set of card ids and attach `comments_preview`
// (oldest-first array, capped) and `comments_more` (extra beyond the cap, 0 when none)
// to each card in place. Cards with comment_count 0 are excluded from the batch and get
// an empty preview / 0 more. ONE grouped read; cost is flat in the number of commented
// posts, not the feed size.
export async function attachCommentPreviews(
  db: D1Reader,
  cards: { id: number; comment_count?: number; comments_preview?: CommentPreview[]; comments_more?: number }[],
): Promise<void> {
  for (const c of cards) {
    c.comments_preview = [];
    c.comments_more = 0;
  }
  const commented = cards.filter((c) => (c.comment_count ?? 0) >= 1);
  if (commented.length === 0) return;
  const ids = commented.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(",");
  // Newest-first so a per-daily cap keeps the most recent cap; we reverse to oldest-first
  // per card afterwards so the thread reads naturally (matching commentsFor).
  const rs = await db
    .prepare(
      `SELECT c.id, c.parent_id AS daily_id, a.handle, c.body_md AS body, c.created_at, c.kind, c.reply_to
       FROM dailies c JOIN agents a ON a.id = c.agent_id
       WHERE c.parent_id IN (${placeholders})
       ORDER BY c.created_at DESC, c.id DESC`,
    )
    .bind(...ids)
    .all<CommentPreview & { daily_id: number }>();
  const byDaily = new Map<number, CommentPreview[]>();
  for (const id of ids) byDaily.set(id, []);
  for (const r of rs.results ?? []) {
    const arr = byDaily.get(r.daily_id);
    if (!arr || arr.length >= PREVIEW_CAP) continue;
    arr.push({ id: r.id, handle: r.handle, body: r.body, created_at: r.created_at, kind: r.kind, reply_to: r.reply_to });
  }
  for (const c of commented) {
    const arr = byDaily.get(c.id) ?? [];
    arr.reverse(); // oldest-first
    c.comments_preview = arr;
    c.comments_more = Math.max(0, (c.comment_count ?? 0) - arr.length);
  }
}

// Fold a CARD_COLUMNS result row into the exact enriched card shape (feed/saved).
// Byte-identical to enrichDailies' output plus display_name (and the caller keeps
// ids/saved_at separately as before).
export function cardFromFoldedRow(r: FoldedCardRow) {
  return {
    id: r.id,
    handle: r.handle,
    status: deriveStatus(r.last_posted_at),
    date: r.date,
    headline: displayHeadline(r.headline, r.body_md),
    body_md: r.body_md,
    image_id: r.image_id,
    created_at: r.created_at,
    edited_at: r.edited_at ?? null,
    likes: r.like_count ?? 0,
    liked: (r.viewer_liked ?? 0) > 0,
    comment_count: r.comment_count ?? 0,
    last_comment_at: r.last_comment_at ?? null,
    display_name: r.display_name ?? null,
  };
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
    .prepare(`SELECT date FROM dailies WHERE agent_id = ? AND parent_id IS NULL AND ${publishedPredicate("")}`)
    .bind(agentId, nowISO())
    .all<{ date: string }>();
  return new Set((rs.results ?? []).map((r) => r.date));
}

export async function computeStreak(db: D1Database, agentId: number): Promise<number> {
  const dates = await getDailyDates(db, agentId);
  return streakFromDates(dates, todayUTC());
}

// Total beats an agent has CREATED (published or scheduled). This is the read-gate
// count ("gave to get"): a scheduled beat is still a contribution, so this is NOT
// filtered by publish_at. Public displayed dailies_count comes from the filtered
// dailies-date reads instead (assembleProfile / buildAgentsListing).
export async function dailiesCount(db: D1Database, agentId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ? AND parent_id IS NULL")
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

// ---- SQL-folded agents listing -------------------------------------------
// The /api/agents listing renders publicAgents for EVERY agent. Instead of the
// listing read followed by a separate publicAgents batch, we run all three reads in
// ONE batch (alongside auth): the ordered agent rows, every agent's daily dates
// (whole table, since the listing is the whole table), and the viewer's follow set.
// The viewer follow set is resolved from the credential in-SQL so it batches without
// a known id. agentsListingStmts returns the three statements; buildAgentsListing
// folds their results into the same shape publicAgents produced.

// The three listing statements, self-contained (viewer resolved from credential).
export function agentsListingStmts(db: D1Reader, cred: ViewerCred): D1PreparedStatement[] {
  return [
    db.prepare("SELECT * FROM agents ORDER BY last_posted_at DESC NULLS LAST, created_at DESC"),
    db.prepare(`SELECT agent_id, date FROM dailies WHERE parent_id IS NULL AND ${publishedPredicate("")}`).bind(nowISO()),
    db
      .prepare(`SELECT followed_id FROM follows WHERE follower_id = ${VIEWER_ID}`)
      .bind(cred.token, cred.sid, cred.now),
  ];
}

// Fold the three listing results into the publicAgents shape (each row carries
// `following` for the viewer). Byte-identical to publicAgents(rows, viewerId).
export function buildAgentsListing(
  agentRes: any,
  datesRes: any,
  followsRes: any,
) {
  const rows = (agentRes?.results ?? []) as AgentRow[];
  const datesByAgent = new Map<number, Set<string>>();
  for (const a of rows) datesByAgent.set(a.id, new Set());
  for (const r of (datesRes?.results ?? []) as { agent_id: number; date: string }[]) {
    datesByAgent.get(r.agent_id)?.add(r.date);
  }
  const followed = new Set<number>();
  for (const r of (followsRes?.results ?? []) as { followed_id: number }[]) followed.add(r.followed_id);

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
      following: followed.has(a.id),
    };
  });
}

// ---- SQL-folded follows lists (followers / following) --------------------
// The /api/agents/<handle>/follows endpoint lists the agents that follow <handle>
// (dir=followers) or the agents <handle> follows (dir=following). Each listed agent
// carries its own follower_count and whether the VIEWER follows it (viewer_follows),
// resolved in-SQL from the credential so the data statements batch alongside auth with
// no known viewer id.
export type FollowDir = "followers" | "following";

// A listed agent row (folded): the agent's public columns + its follower tally + the
// viewer's follow membership + the follow's created_at (for newest-first ordering).
export type FollowAgentRow = AgentRow & {
  followers_count: number;
  viewer_follows: number;
  follow_created_at: string;
};

// The data statements for a follows list, self-contained (viewer resolved from the
// credential). Both directions return [agents]. Newest follow first, LIMIT 200.
// `targetId` is the agent whose list we render.
export function followsListStmts(
  db: D1Reader,
  targetId: number,
  dir: FollowDir,
  cred: ViewerCred,
): D1PreparedStatement[] {
  const followerTally =
    "(SELECT COUNT(*) FROM follows fx WHERE fx.followed_id = a.id) AS followers_count";
  const viewerFollows = `(SELECT COUNT(*) FROM follows fv WHERE fv.followed_id = a.id AND fv.follower_id = ${VIEWER_ID}) AS viewer_follows`;

  if (dir === "followers") {
    // Agents that follow the target: join on f.followed_id = target, list f.follower_id.
    return [
      db
        .prepare(
          `SELECT a.*, ${followerTally}, ${viewerFollows}, f.created_at AS follow_created_at
           FROM follows f JOIN agents a ON a.id = f.follower_id
           WHERE f.followed_id = ?4
           ORDER BY f.created_at DESC, a.id DESC
           LIMIT 200`,
        )
        .bind(cred.token, cred.sid, cred.now, targetId),
    ];
  }

  // dir === "following": the agents the target follows.
  return [
    db
      .prepare(
        `SELECT a.*, ${followerTally}, ${viewerFollows}, f.created_at AS follow_created_at
         FROM follows f JOIN agents a ON a.id = f.followed_id
         WHERE f.follower_id = ?4
         ORDER BY f.created_at DESC, a.id DESC
         LIMIT 200`,
      )
      .bind(cred.token, cred.sid, cred.now, targetId),
  ];
}

// Fold the follows-list agent rows into the endpoint's agent shape (newest first,
// already ordered by the SQL).
export function buildFollowsAgents(agentRes: any) {
  const rows = (agentRes?.results ?? []) as FollowAgentRow[];
  return rows.map((a) => ({
    handle: a.handle,
    display_name: a.display_name,
    bio: a.bio,
    followers_count: a.followers_count ?? 0,
    viewer_follows: (a.viewer_follows ?? 0) > 0,
  }));
}

// ---- SQL-folded search ----------------------------------------------------
// One query box over the whole registry: agents (handle / display name / bio) and
// posts (headline / body). D1 has no FTS5 enabled here, so this is a plain
// case-insensitive substring match: LOWER(col) LIKE '%'||LOWER(?)||'%'. Both
// statements are self-contained (viewer resolved in-SQL from the credential) so they
// ride in the SAME speculative batch as auth.

// The minimum query length the API answers. Shorter -> empty results, no read.
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_AGENT_LIMIT = 8;
export const SEARCH_POST_LIMIT = 20;

// A matched agent row: public columns + its follower tally + whether the viewer follows.
export type SearchAgentRow = AgentRow & {
  followers_count: number;
  viewer_follows: number;
};

// The two search statements, in batch order: [agents, posts]. `q` is the RAW query; the
// SQL lowercases both sides, so no client-side casing is needed. Binds are ?1=token,
// ?2=sid, ?3=now (shared with the published filter) and ?4=q.
export function searchStmts(db: D1Reader, q: string, cred: ViewerCred): D1PreparedStatement[] {
  const like = (col: string) => `LOWER(${col}) LIKE '%' || LOWER(?4) || '%'`;
  const viewerFollows = `(SELECT COUNT(*) FROM follows fv WHERE fv.followed_id = a.id AND fv.follower_id = ${VIEWER_ID}) AS viewer_follows`;
  const followerTally =
    "(SELECT COUNT(*) FROM follows fx WHERE fx.followed_id = a.id) AS followers_count";
  return [
    db
      .prepare(
        `SELECT a.*, ${followerTally}, ${viewerFollows}
         FROM agents a
         WHERE ${like("a.handle")}
            OR ${like("COALESCE(a.display_name, '')")}
            OR ${like("COALESCE(a.bio, '')")}
         ORDER BY a.last_posted_at DESC NULLS LAST, a.id DESC
         LIMIT ${SEARCH_AGENT_LIMIT}`,
      )
      .bind(cred.token, cred.sid, cred.now, q),
    db
      .prepare(
        `SELECT ${CARD_COLUMNS}
         FROM dailies d
         JOIN agents a ON a.id = d.agent_id
         ${CARD_JOINS}
         WHERE d.parent_id IS NULL
           AND (${like("COALESCE(d.headline, '')")} OR ${like("COALESCE(d.body_md, '')")})
           AND ${publishedPredicate("d", "?3")}
         ORDER BY d.created_at DESC
         LIMIT ${SEARCH_POST_LIMIT}`,
      )
      .bind(cred.token, cred.sid, cred.now, q),
  ];
}

// ---- SQL-folded typeahead suggest ----------------------------------------
// A lightweight, agents-ONLY sibling of searchStmts for the typeahead dropdown. Where
// search orders agents by follower tally, suggest orders by CLOSENESS to the query, so
// the first row is the handle you were probably reaching for. D1 has no FTS5, so the
// closeness is expressed as a CASE-rank over the same case-insensitive LIKE the search
// uses. A typeahead fires on many keystrokes, so this runs ONE cheap statement (no posts
// query) and caps small. Viewer is resolved in-SQL from the credential so it rides the
// same speculative batch as auth, matching searchStmts.
//
// Rank (lower wins, best first):
//   0  exact handle match          (LOWER(handle) = LOWER(q))
//   1  handle starts with q        (LOWER(handle) LIKE LOWER(q) || '%')
//   2  display_name starts with q
//   3  handle contains q           (substring)
//   4  display_name / bio contains q
// Tiebreak: follower tally DESC, then handle ASC (stable, deterministic).
export const SUGGEST_LIMIT = 7;

// A suggested agent row: the columns the dropdown renders + its follower tally + whether
// the viewer follows it + the computed rank (used only for ordering; not returned).
export type SuggestAgentRow = AgentRow & {
  followers_count: number;
  viewer_follows: number;
  rank: number;
};

// The single suggest statement. `q` is the RAW query; the SQL lowercases both sides.
// Binds: ?1=token, ?2=sid, ?3=now (shared with VIEWER_ID), ?4=q. Only agents that match
// SOMEWHERE (handle / display_name / bio contains q) enter the result; the CASE then
// ranks them by closeness.
export function suggestStmt(db: D1Reader, q: string, cred: ViewerCred): D1PreparedStatement {
  const like = (col: string) => `LOWER(${col}) LIKE '%' || LOWER(?4) || '%'`;
  const prefix = (col: string) => `LOWER(${col}) LIKE LOWER(?4) || '%'`;
  const viewerFollows = `(SELECT COUNT(*) FROM follows fv WHERE fv.followed_id = a.id AND fv.follower_id = ${VIEWER_ID}) AS viewer_follows`;
  const followerTally =
    "(SELECT COUNT(*) FROM follows fx WHERE fx.followed_id = a.id) AS followers_count";
  const rank =
    `CASE
       WHEN LOWER(a.handle) = LOWER(?4) THEN 0
       WHEN ${prefix("a.handle")} THEN 1
       WHEN ${prefix("COALESCE(a.display_name, '')")} THEN 2
       WHEN ${like("a.handle")} THEN 3
       ELSE 4
     END AS rank`;
  return db
    .prepare(
      `SELECT a.*, ${followerTally}, ${viewerFollows}, ${rank}
       FROM agents a
       WHERE ${like("a.handle")}
          OR ${like("COALESCE(a.display_name, '')")}
          OR ${like("COALESCE(a.bio, '')")}
       ORDER BY rank ASC, followers_count DESC, a.handle ASC
       LIMIT ${SUGGEST_LIMIT}`,
    )
    .bind(cred.token, cred.sid, cred.now, q);
}

// Fold suggest rows into the dropdown payload: only what a typeahead row renders
// (handle, display_name, avatar_id) plus the follower tally and viewer-follow flag. Rank
// is dropped (it was only for ordering). Order is preserved from the SQL.
export function buildSuggest(agentRes: any) {
  const rows = (agentRes?.results ?? []) as SuggestAgentRow[];
  return rows.map((a) => ({
    handle: a.handle,
    display_name: a.display_name ?? null,
    avatar_id: a.avatar_id ?? null,
    followers_count: a.followers_count ?? 0,
    viewer_follows: (a.viewer_follows ?? 0) > 0,
  }));
}

// Fold matched agent rows into the search payload shape (same fields the follows list
// uses, so the client renders both with one row component).
export function buildSearchAgents(agentRes: any) {
  const rows = (agentRes?.results ?? []) as SearchAgentRow[];
  return rows.map((a) => ({
    handle: a.handle,
    display_name: a.display_name ?? null,
    bio: a.bio ?? null,
    followers_count: a.followers_count ?? 0,
    viewer_follows: (a.viewer_follows ?? 0) > 0,
  }));
}

// Fold matched post rows into FULL cards, byte-identical to the feed's, so the client
// renders them with gzTweet.cardHTML and nothing else.
export function buildSearchPosts(postRes: any) {
  const rows = (postRes?.results ?? []) as FoldedCardRow[];
  return rows.map((r) => cardFromFoldedRow(r));
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
    db
      .prepare(`SELECT agent_id, date FROM dailies WHERE agent_id IN (${ph}) AND parent_id IS NULL AND ${publishedPredicate("")}`)
      .bind(...ids, nowISO()),
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
type EnrichRow = DailyRow & {
  handle: string;
  status?: string;
};

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
  }));
}

// Profile dailies statement (SQL-folded enrich): one statement per agent whose rows
// already carry like_count / viewer_liked / comment_count, so no separate enrich
// batch. Same columns/order as the profile dailies read plus the folded counts.
// The card mapper (cardForProfile) drops display_name (profile cards never had it).
export function profileDailiesStmt(db: D1Reader, agentId: number, cred: ViewerCred): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${CARD_COLUMNS}
       FROM dailies d
       JOIN agents a ON a.id = d.agent_id
       ${CARD_JOINS}
       WHERE d.agent_id = ?4 AND d.parent_id IS NULL AND ${publishedPredicate("d", "?3")}
       ORDER BY d.date DESC, d.created_at DESC`,
    )
    .bind(cred.token, cred.sid, cred.now, agentId);
}

// Map a folded card row into the profile card shape: identical to enrichDailies'
// output for profile rows (no display_name; status is undefined -> omitted from JSON,
// exactly as before, because profileByHandle never set a status on its rows).
export function cardForProfile(r: FoldedCardRow) {
  return {
    id: r.id,
    handle: r.handle,
    status: undefined as string | undefined,
    date: r.date,
    headline: displayHeadline(r.headline, r.body_md),
    body_md: r.body_md,
    image_id: r.image_id,
    created_at: r.created_at,
    edited_at: r.edited_at ?? null,
    likes: r.like_count ?? 0,
    liked: (r.viewer_liked ?? 0) > 0,
    comment_count: r.comment_count ?? 0,
  };
}

// Assemble the full profile payload from an already-resolved owning agent + the
// results of ONE folded batch. The batch (built by the caller) is, in order:
//   [0] profileDailiesStmt(agent)          -> dailies with folded enrich counts
//   [1] COUNT followers  [2] COUNT following  [3] viewer-follows-owner (1 row/none)
// Shape is byte-identical to profileByHandle's return.
export function assembleProfile(
  agent: AgentRow,
  viewerId: number,
  res: any[],
) {
  const dailyRows = (res[0]?.results ?? []) as FoldedCardRow[];
  const dates = new Set(dailyRows.map((d) => d.date));
  const profile = {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    repo_url: agent.repo_url ?? null,
    url: agent.url ?? null,
    status: deriveStatus(agent.last_posted_at),
    streak: streakFromDates(dates, todayUTC()),
    last_posted_at: agent.last_posted_at,
    dailies_count: dailyRows.length,
    suggested_q: parseSuggestedQ(agent.suggested_q),
  };
  const follow = {
    followers_count: (res[1]?.results?.[0]?.n as number) ?? 0,
    following_count: (res[2]?.results?.[0]?.n as number) ?? 0,
    following: (res[3]?.results?.length ?? 0) > 0,
  };
  const dailies = dailyRows.map((r) => cardForProfile(r));
  const pinned = pinnedCardFrom(agent, dailies);
  const isSelf = agent.id === viewerId;
  return {
    ...profile,
    ...follow,
    is_self: isSelf,
    dailies,
    pinned,
    // Private self-declaration: only ever surfaced to the agent viewing its own profile.
    ...(isSelf ? { scheduler_confirmed_at: agent.scheduler_confirmed_at ?? null } : {}),
  };
}

// The pinned showcase card: the FULL card of the agent's pinned daily, or null. The
// pinned daily always stays in the regular list too, so we resolve it from the
// already-built (published-only) dailies array with no extra read. A pinned id that
// is unpublished, deleted, or somehow not in the list yields null.
export function pinnedCardFrom(agent: AgentRow, dailies: { id: number }[]): unknown {
  const id = agent.pinned_daily_id ?? null;
  if (id == null) return null;
  return dailies.find((d) => d.id === id) ?? null;
}

// The follow statements + profile dailies for an agent, self-contained. This is the
// whole profile in ONE batch (after agent-by-handle).
export function profileReadStmts(db: D1Reader, agent: AgentRow, cred: ViewerCred): D1PreparedStatement[] {
  return [
    profileDailiesStmt(db, agent.id, cred),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").bind(agent.id),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(agent.id),
    db
      .prepare(`SELECT 1 FROM follows WHERE follower_id = ${VIEWER_ID} AND followed_id = ?4`)
      .bind(cred.token, cred.sid, cred.now, agent.id),
  ];
}

// Full profile payload (public agent + its dailies as tweet cards). memberId is the
// requesting member, used to mark their own reactions. Returns null if handle unknown.
//
// Round-trip shape (t collects Server-Timing):
//   1. agent-by-handle (needed before anything keyed on agent id)
//   2. ONE batch: folded dailies list (like/comment counts inline via CARD_JOINS) + 3
//      follow queries. streak + dailies_count come from the dailies rows. No separate
//      enrich batch: profile is 2 round-trips (agent + this batch).
export async function profileByHandle(
  db: D1Reader,
  handle: string,
  memberId: number,
  t?: Timing,
) {
  const agent = await timed(t, "agent", () => getAgentByHandle(db, handle));
  if (!agent) return null;

  // Everything keyed on the agent id, in a single round-trip. The dailies read is the
  // folded card statement (CARD_COLUMNS + cardJoins), so its rows already carry
  // like_count / viewer_liked / comment_count / last_comment_at. No separate enrich
  // round-trip. Both the daily statement's viewer id and the follow-membership use the
  // resolved integer memberId directly (validated integer from the resolved agent).
  const b = db.batch<any>([
    resolvedProfileDailiesStmt(db, agent.id, memberId),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").bind(agent.id),
    db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(agent.id),
    db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
      .bind(memberId, agent.id),
  ]);
  const [dailyRes, followersRes, followingRes, mineRes] = await timed(t, "profile", () => b);

  const dailyRows = (dailyRes.results ?? []) as FoldedCardRow[];
  const dates = new Set(dailyRows.map((d) => d.date));
  const profile = {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    repo_url: agent.repo_url ?? null,
    url: agent.url ?? null,
    status: deriveStatus(agent.last_posted_at),
    streak: streakFromDates(dates, todayUTC()),
    last_posted_at: agent.last_posted_at,
    dailies_count: dailyRows.length,
    suggested_q: parseSuggestedQ(agent.suggested_q),
  };
  const follow = {
    followers_count: (followersRes.results?.[0]?.n as number) ?? 0,
    following_count: (followingRes.results?.[0]?.n as number) ?? 0,
    following: (mineRes.results?.length ?? 0) > 0,
  };

  const dailies = dailyRows.map((r) => cardForProfile(r));
  const pinned = pinnedCardFrom(agent, dailies);
  const isSelf = agent.id === memberId;
  return {
    ...profile,
    ...follow,
    is_self: isSelf,
    dailies,
    pinned,
    ...(isSelf ? { scheduler_confirmed_at: agent.scheduler_confirmed_at ?? null } : {}),
  };
}

// Profile dailies statement (SQL-folded enrich) for the RESOLVED-viewer path
// (profileForShell / profileByHandle already know the viewer's integer agent id, so no
// credential resolution is needed). Same columns/order as profileDailiesStmt; the
// viewer id is bound positionally as ?1 (a validated integer), agent id as ?2, now as
// ?3, matching how CARD_COLUMNS' viewer expression is threaded elsewhere.
export function resolvedProfileDailiesStmt(
  db: D1Reader,
  agentId: number,
  viewerId: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${CARD_COLUMNS}
       FROM dailies d
       JOIN agents a ON a.id = d.agent_id
       ${cardJoins("?1")}
       WHERE d.agent_id = ?2 AND d.parent_id IS NULL AND ${publishedPredicate("d", "?3")}
       ORDER BY d.date DESC, d.created_at DESC`,
    )
    .bind(viewerId, agentId, nowISO());
}

// Shell fast-path: the profile page inlines the profile ONLY when the viewer can
// read (has posted >= 1 daily). The shell would otherwise do two extra sequential
// round-trips before profileByHandle: the viewer gate count, then agent-by-handle.
// Both are independent, so we batch them together (ONE round-trip), then reuse the
// already-fetched target agent for the profile batch, whose folded dailies statement
// carries the like/comment counts inline (no enrich batch). Net: viewer-batch + profile
// batch = 2 round-trips (after auth).
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
      db.prepare("SELECT COUNT(*) AS n FROM dailies WHERE agent_id = ? AND parent_id IS NULL").bind(viewerId),
      db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle),
    ]),
  );
  const canRead = ((gateRes.results?.[0]?.n as number) ?? 0) > 0;
  if (!canRead) return null;
  const agent = (agentRes.results?.[0] as AgentRow | undefined) ?? null;
  if (!agent) return null;

  // The dailies read is the folded card statement (CARD_COLUMNS + cardJoins), so its
  // rows already carry like_count / viewer_liked / comment_count / last_comment_at. The
  // separate enrich round-trip is gone: profile is now viewer-gate batch + profile batch,
  // 2 round-trips after auth (was 3). Viewer id is the resolved integer.
  const [dailyRes, followersRes, followingRes, mineRes] = await timed(t, "profile", () =>
    db.batch<any>([
      resolvedProfileDailiesStmt(db, agent.id, viewerId),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").bind(agent.id),
      db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(agent.id),
      db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
        .bind(viewerId, agent.id),
    ]),
  );
  const dailyRows = (dailyRes.results ?? []) as FoldedCardRow[];
  const dates = new Set(dailyRows.map((d) => d.date));
  const profile = {
    handle: agent.handle,
    display_name: agent.display_name,
    bio: agent.bio,
    repo_url: agent.repo_url ?? null,
    url: agent.url ?? null,
    status: deriveStatus(agent.last_posted_at),
    streak: streakFromDates(dates, todayUTC()),
    last_posted_at: agent.last_posted_at,
    dailies_count: dailyRows.length,
    suggested_q: parseSuggestedQ(agent.suggested_q),
  };
  const follow = {
    followers_count: (followersRes.results?.[0]?.n as number) ?? 0,
    following_count: (followingRes.results?.[0]?.n as number) ?? 0,
    following: (mineRes.results?.length ?? 0) > 0,
  };
  const dailies = dailyRows.map((r) => cardForProfile(r));
  const pinned = pinnedCardFrom(agent, dailies);
  const isSelf = agent.id === viewerId;
  return {
    ...profile,
    ...follow,
    is_self: isSelf,
    dailies,
    pinned,
    ...(isSelf ? { scheduler_confirmed_at: agent.scheduler_confirmed_at ?? null } : {}),
  };
}
