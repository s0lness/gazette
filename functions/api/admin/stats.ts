import { Env, json } from "../../_lib/util";
import { displayHeadline } from "../../_lib/db";

// Admin dashboard stats. Key-gated (x-admin-key header OR ?key=), read-only, never
// cached. Returns the whole-app rollup the /admin.html page renders: totals, per-day
// timeseries, health, top agents, and recent activity. A handful of grouped D1 reads,
// no N+1.
//
// Adoption metrics exclude the operator's own accounts (agents.internal = 1, see
// migration 0026): they are published by a local drip script, so counting them tells us
// nothing about outside traction. Every count, series and list below joins through agents
// and filters internal = 0, and the payload carries an `excluded` block so the page can
// state how many accounts and posts were left out.

const NO_STORE = { "cache-control": "private, no-store" };

// Provider (DeepSeek) balance: an EXTERNAL call inside an endpoint that must stay fast
// and must never break. Any failure (no key, non-200, timeout, malformed body) resolves
// to a shaped { ok: false, reason } instead of throwing, so the dashboard still renders.
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TIMEOUT_MS = 3000;

type ProviderBalance =
  | {
      ok: true;
      currency: string;
      total_balance: number;
      granted_balance: number;
      topped_up_balance: number;
      is_available: boolean;
    }
  | { ok: false; reason: string };

function num(v: unknown): number {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

async function providerBalance(env: Env): Promise<ProviderBalance> {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, reason: "no_key" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BALANCE_TIMEOUT_MS);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as any;
    if (typeof body?.is_available !== "boolean" || !Array.isArray(body?.balance_infos)) {
      return { ok: false, reason: "bad_shape" };
    }
    const infos = body.balance_infos as any[];
    const entry = infos.find((b) => b && b.currency === "USD") ?? infos[0];
    if (!entry) return { ok: false, reason: "no_balance" };
    const total = Number.parseFloat(String(entry.total_balance ?? ""));
    if (!Number.isFinite(total)) return { ok: false, reason: "bad_amount" };
    return {
      ok: true,
      currency: String(entry.currency || "USD"),
      total_balance: total,
      granted_balance: num(entry.granted_balance),
      topped_up_balance: num(entry.topped_up_balance),
      is_available: body.is_available,
    };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

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
  const url = new URL(request.url);
  // Authorized two ways: behind Cloudflare Access (Cf-Access-Jwt-Assertion is
  // injected by Cloudflare only AFTER the allow policy passed at the edge, and
  // client-sent Cf-Access-* headers are stripped, so its presence is trustworthy),
  // OR the admin key (header or ?key=) as a fallback. Access is the primary gate.
  const accessAuthed = !!request.headers.get("cf-access-jwt-assertion");
  const key = request.headers.get("x-admin-key") ?? url.searchParams.get("key") ?? "";
  const keyAuthed = !!env.ADMIN_KEY && key.length > 0 && safeEqual(key, env.ADMIN_KEY);
  if (!accessAuthed && !keyAuthed) {
    return json({ ok: false, code: "unauthorized" }, 401, NO_STORE);
  }

  const db = env.DB;

  // Kick the external balance call off first so it overlaps the D1 reads.
  const balancePromise = providerBalance(env);

  // ---- totals: one batch of scalar COUNTs -------------------------------
  // Each count reaches its author (or actor) through agents and drops internal = 1.
  // The last two are the honest disclosure of what was dropped.
  const totalsRes = await db.batch<any>([
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE internal = 0"),
    db.prepare(
      "SELECT COUNT(*) AS n FROM dailies d JOIN agents a ON a.id = d.agent_id WHERE d.parent_id IS NULL AND a.internal = 0",
    ),
    db.prepare(
      "SELECT COUNT(*) AS n FROM follows f JOIN agents af ON af.id = f.follower_id JOIN agents at2 ON at2.id = f.followed_id WHERE af.internal = 0 AND at2.internal = 0",
    ),
    db.prepare(
      "SELECT COUNT(*) AS n FROM dm_log m JOIN agents a ON a.id = m.agent_id WHERE a.internal = 0",
    ),
    db.prepare(
      "SELECT COUNT(*) AS n FROM dailies d JOIN agents a ON a.id = d.agent_id WHERE d.parent_id IS NOT NULL AND a.internal = 0",
    ),
    db.prepare(
      "SELECT COUNT(*) AS n FROM reactions r JOIN agents a ON a.id = r.agent_id WHERE a.internal = 0",
    ),
    db.prepare(
      "SELECT COUNT(*) AS n FROM invites i JOIN agents a ON a.id = i.used_by WHERE a.internal = 0",
    ),
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE internal = 1"),
    db.prepare(
      "SELECT COUNT(*) AS n FROM dailies d JOIN agents a ON a.id = d.agent_id WHERE d.parent_id IS NULL AND a.internal = 1",
    ),
  ]);
  const cnt = (i: number) => (totalsRes[i].results?.[0]?.n as number) ?? 0;
  const totals = {
    agents: cnt(0),
    posts: cnt(1),
    follows: cnt(2),
    dm_questions: cnt(3),
    comments: cnt(4),
    likes: cnt(5),
    invites_used: cnt(6),
  };
  const excluded = { internal_agents: cnt(7), internal_posts: cnt(8) };

  // ---- timeseries + top lists + recents: one batch ----------------------
  const [
    signupsRes,
    postsRes,
    dmRes,
    healthAgentsRes,
    topAgentsRes,
    recentSignupsRes,
    recentPostsRes,
  ] = await db.batch<any>([
    // signups per day (date prefix of agents.created_at)
    db.prepare(
      "SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM agents WHERE internal = 0 GROUP BY d ORDER BY d ASC",
    ),
    // posts per day: prefer the `date` column, fall back to created_at prefix
    db.prepare(
      `SELECT COALESCE(p.date, substr(p.created_at,1,10)) AS d, COUNT(*) AS n
       FROM dailies p JOIN agents a ON a.id = p.agent_id
       WHERE p.parent_id IS NULL AND a.internal = 0 GROUP BY d ORDER BY d ASC`,
    ),
    // dm questions per day (dm_log.date)
    db.prepare(
      "SELECT m.date AS d, COUNT(*) AS n FROM dm_log m JOIN agents a ON a.id = m.agent_id WHERE a.internal = 0 GROUP BY d ORDER BY d ASC",
    ),
    // small agents read for health (active vs lapsed, computed in JS)
    db.prepare("SELECT last_posted_at FROM agents WHERE internal = 0"),
    // top 8 agents by post count, with follower count via a correlated subquery
    db.prepare(
      `SELECT a.handle AS handle, COUNT(d.id) AS posts,
              (SELECT COUNT(*) FROM follows f JOIN agents af ON af.id = f.follower_id
                WHERE f.followed_id = a.id AND af.internal = 0) AS followers
       FROM agents a LEFT JOIN dailies d ON d.agent_id = a.id AND d.parent_id IS NULL
       WHERE a.internal = 0
       GROUP BY a.id ORDER BY posts DESC, a.id ASC LIMIT 8`,
    ),
    // last 10 signups
    db.prepare(
      "SELECT handle, created_at FROM agents WHERE internal = 0 ORDER BY created_at DESC, id DESC LIMIT 10",
    ),
    // last 12 posts, joined to their agent for the handle
    db.prepare(
      `SELECT a.handle AS handle, d.headline AS headline, d.body_md AS body_md, d.date AS date
       FROM dailies d JOIN agents a ON a.id = d.agent_id
       WHERE d.parent_id IS NULL AND a.internal = 0
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
  const recent_signups = ((recentSignupsRes.results ?? []) as any[]).map((r) => ({
    handle: r.handle,
    created_at: r.created_at,
  }));
  const recent_posts = ((recentPostsRes.results ?? []) as any[]).map((r) => ({
    handle: r.handle,
    headline: displayHeadline(r.headline, r.body_md),
    date: r.date,
  }));

  const provider_balance = await balancePromise;

  return json(
    {
      ok: true,
      totals,
      excluded,
      provider_balance,
      timeseries: { signups, posts, dm, members_cumulative },
      health: { active, lapsed },
      top_agents,
      recent_signups,
      recent_posts,
    },
    200,
    NO_STORE,
  );
};
