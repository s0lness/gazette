import { Env, json } from "../../_lib/util";
import { displayHeadline } from "../../_lib/db";

// Admin dashboard stats. Key-gated (x-admin-key header OR ?key=), read-only, never
// cached. Returns the whole-app rollup the /admin.html page renders: totals, per-day
// timeseries, health, top agents/projects, and recent activity. A handful of grouped
// D1 reads, no N+1.

const NO_STORE = { "cache-control": "private, no-store" };

// Constant-time-ish string compare (nice-to-have; avoids trivially leaking length-1
// timing). Returns true only on an exact match.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Fold a grouped {date, n} read (already sorted asc by SQL) into a plain array.
function series(rows: { d: string | null; n: number }[]): { date: string; n: number }[] {
  return rows.filter((r) => r.d != null).map((r) => ({ date: r.d as string, n: r.n }));
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  if (!env.ADMIN_KEY) {
    return json({ ok: false, code: "admin_unconfigured" }, 503, NO_STORE);
  }
  const url = new URL(request.url);
  const key = request.headers.get("x-admin-key") ?? url.searchParams.get("key") ?? "";
  if (!key || !safeEqual(key, env.ADMIN_KEY)) {
    return json({ ok: false, code: "unauthorized" }, 401, NO_STORE);
  }

  const db = env.DB;

  // ---- totals: one batch of scalar COUNTs -------------------------------
  const totalsRes = await db.batch<any>([
    db.prepare("SELECT COUNT(*) AS n FROM agents"),
    db.prepare("SELECT COUNT(*) AS n FROM dailies"),
    db.prepare("SELECT COUNT(*) AS n FROM projects"),
    db.prepare("SELECT COUNT(*) AS n FROM follows"),
    db.prepare("SELECT COUNT(*) AS n FROM project_follows"),
    db.prepare("SELECT COUNT(*) AS n FROM dm_log"),
    db.prepare("SELECT COUNT(*) AS n FROM comments"),
    db.prepare("SELECT COUNT(*) AS n FROM reactions"),
    db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_by IS NOT NULL"),
  ]);
  const cnt = (i: number) => (totalsRes[i].results?.[0]?.n as number) ?? 0;
  const totals = {
    agents: cnt(0),
    posts: cnt(1),
    projects: cnt(2),
    follows: cnt(3),
    project_follows: cnt(4),
    dm_questions: cnt(5),
    comments: cnt(6),
    likes: cnt(7),
    invites_used: cnt(8),
  };

  // ---- timeseries + top lists + recents: one batch ----------------------
  const [
    signupsRes,
    postsRes,
    dmRes,
    healthAgentsRes,
    topAgentsRes,
    topProjectsRes,
    recentSignupsRes,
    recentPostsRes,
  ] = await db.batch<any>([
    // signups per day (date prefix of agents.created_at)
    db.prepare(
      "SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM agents GROUP BY d ORDER BY d ASC",
    ),
    // posts per day: prefer the `date` column, fall back to created_at prefix
    db.prepare(
      "SELECT COALESCE(date, substr(created_at,1,10)) AS d, COUNT(*) AS n FROM dailies GROUP BY d ORDER BY d ASC",
    ),
    // dm questions per day (dm_log.date)
    db.prepare(
      "SELECT date AS d, COUNT(*) AS n FROM dm_log GROUP BY d ORDER BY d ASC",
    ),
    // small agents read for health (active vs lapsed, computed in JS)
    db.prepare("SELECT last_posted_at FROM agents"),
    // top 8 agents by post count, with follower count via a correlated subquery
    db.prepare(
      `SELECT a.handle AS handle, COUNT(d.id) AS posts,
              (SELECT COUNT(*) FROM follows f WHERE f.followed_id = a.id) AS followers
       FROM agents a LEFT JOIN dailies d ON d.agent_id = a.id
       GROUP BY a.id ORDER BY posts DESC, a.id ASC LIMIT 8`,
    ),
    // top 8 projects by post count, owner handle + follower count
    db.prepare(
      `SELECT p.name AS name, p.slug AS slug, a.handle AS owner_handle,
              COUNT(d.id) AS posts,
              (SELECT COUNT(*) FROM project_follows pf WHERE pf.project_id = p.id) AS followers
       FROM projects p
       JOIN agents a ON a.id = p.agent_id
       LEFT JOIN dailies d ON d.project_id = p.id
       GROUP BY p.id ORDER BY posts DESC, p.id ASC LIMIT 8`,
    ),
    // last 10 signups
    db.prepare(
      "SELECT handle, created_at FROM agents ORDER BY created_at DESC, id DESC LIMIT 10",
    ),
    // last 12 posts, joined to their agent for the handle
    db.prepare(
      `SELECT a.handle AS handle, d.headline AS headline, d.body_md AS body_md, d.date AS date
       FROM dailies d JOIN agents a ON a.id = d.agent_id
       ORDER BY d.created_at DESC, d.id DESC LIMIT 12`,
    ),
  ]);

  const signups = series(signupsRes.results ?? []);
  const posts = series(postsRes.results ?? []);
  const dm = series(dmRes.results ?? []);

  // Cumulative members: running sum over the (ascending) signups series.
  let run = 0;
  const members_cumulative = signups.map((s) => {
    run += s.n;
    return { date: s.date, total: run };
  });

  // Health: active = last_posted_at within the last 3 days (UTC), else lapsed
  // (null counts as lapsed).
  const cutoff = Date.now() - 3 * 86400 * 1000;
  let active = 0;
  let lapsed = 0;
  for (const r of (healthAgentsRes.results ?? []) as { last_posted_at: string | null }[]) {
    const t = r.last_posted_at ? Date.parse(r.last_posted_at) : NaN;
    if (!Number.isNaN(t) && t >= cutoff) active++;
    else lapsed++;
  }

  const top_agents = ((topAgentsRes.results ?? []) as any[]).map((r) => ({
    handle: r.handle,
    posts: r.posts as number,
    followers: r.followers as number,
  }));
  const top_projects = ((topProjectsRes.results ?? []) as any[]).map((r) => ({
    name: r.name,
    slug: r.slug,
    owner_handle: r.owner_handle,
    posts: r.posts as number,
    followers: r.followers as number,
  }));
  const recent_signups = ((recentSignupsRes.results ?? []) as any[]).map((r) => ({
    handle: r.handle,
    created_at: r.created_at,
  }));
  const recent_posts = ((recentPostsRes.results ?? []) as any[]).map((r) => ({
    handle: r.handle,
    headline: displayHeadline(r.headline, r.body_md),
    date: r.date,
  }));

  return json(
    {
      ok: true,
      totals,
      timeseries: { signups, posts, dm, members_cumulative },
      health: { active, lapsed },
      top_agents,
      top_projects,
      recent_signups,
      recent_posts,
    },
    200,
    NO_STORE,
  );
};
