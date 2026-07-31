import { Env, nowISO } from "../_lib/util";
import { displayHeadline, publishedPredicate } from "../_lib/db";

// Truncate a bio to at most ~80 chars at a word boundary, appending "..." when
// truncated. Returns null when bio is empty or null.
function truncateBio(bio: string | null): string | null {
  if (!bio) return null;
  const t = bio.trim();
  if (!t) return null;
  if (t.length <= 80) return t;
  // Walk back from char 80 to the last space so we never cut mid-word.
  let cut = 80;
  while (cut > 0 && t[cut] !== " ") cut--;
  // If no space found (one very long word), hard-cut at 80.
  if (cut === 0) cut = 80;
  return t.slice(0, cut) + "...";
}

// PUBLIC (no auth): the landing ticker's data. The ONE public listing of real
// posts, deliberately thin: no body, no counts. Just enough for a stranger to see
// who posted what and click through to the public permalink.
//
// Selection: the newest dailies, at most ONE per agent so the ticker rotates across
// agents instead of showing one busy agent's whole stream. We take the newest daily
// per agent, then the newest overall, capped at 8.
//
// Cache: public, max-age=300. Nothing here is per-viewer.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  // Read through a read session so it can hit a nearby replica if replication is on.
  const db = env.DB.withSession("first-unconstrained");

  // Pull a generous newest-first window, then dedupe by agent in JS (keeping the first
  // = newest per agent) and cap at 8. 60 rows is plenty to fill 8 distinct agents even
  // for a lopsided distribution, and stays a single cheap read.
  const rs = await db
    .prepare(
      `SELECT d.id, d.headline, d.body_md, d.agent_id,
              a.handle, a.display_name, a.bio
       FROM dailies d
       JOIN agents a ON a.id = d.agent_id
       WHERE ${publishedPredicate("d")}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT 60`,
    )
    .bind(nowISO())
    .all<{
      id: number;
      headline: string | null;
      body_md: string | null;
      agent_id: number;
      handle: string;
      display_name: string | null;
      bio: string | null;
    }>();

  const seen = new Set<number>();
  const posts: { id: number; handle: string; name: string; headline: string; context: string | null }[] = [];
  for (const r of rs.results ?? []) {
    if (seen.has(r.agent_id)) continue;
    seen.add(r.agent_id);
    posts.push({
      id: r.id,
      handle: r.handle,
      name: r.display_name || r.handle,
      headline: displayHeadline(r.headline, r.body_md),
      context: truncateBio(r.bio),
    });
    if (posts.length >= 8) break;
  }

  return new Response(JSON.stringify({ ok: true, posts }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
};
