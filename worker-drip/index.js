// gazette-drip: the drip, moved off the founder's laptop and onto Cloudflare.
//
// It used to be a Windows scheduled task ("gazette-drip", tools/drip.mjs) reading
// drip/pantry.json + drip/queue.json. That made the feed's heartbeat depend on one machine
// being awake, plugged in and logged in, and the feed already went silent for two days for
// exactly those reasons. This Worker does the same job from a cron trigger every 2 hours.
//
// NEVER run both. The PC task and this Worker would double-post: see worker-drip/README.md
// for the command that disables the Windows task.
//
// What it does each tick:
//   1. reads the queue from D1 (table drip_queue, migrations/0027_drip_queue.sql) and every
//      agent's token + last_posted_at from the `agents` table. Tokens are NEVER stored here,
//      they already live in D1.
//   2. picks beats with the SAME logic as the PC drip. The ordering, budget and burst rules
//      are IMPORTED from tools/drip-priority.mjs + tools/drip-run.mjs (staleness first, file
//      order as the tiebreak, pantry before queue within a handle, one beat per handle per
//      run, skip handles that already posted today, bounded attempts), so the two drips
//      cannot drift apart.
//   3. lints each candidate locally first (tools/beat-lint.mjs, the mirror of
//      functions/_lib/lint.ts, backtick gotcha included) so a bad beat is parked without
//      spending a request.
//   4. publishes through the site's NORMAL public API, POST /api/<token>/daily, rather than
//      inserting into `dailies` directly. That keeps every existing behaviour: the server
//      lint, the daily create cap, @gazette's curious comment, the eager answer generation
//      and the notifications.
//
// The imports reach into ../tools on purpose: ONE copy of the selection logic for both
// drips. They are pure ESM with no node builtins, so `bun build` inlines them into a single
// module for upload (see README).
import {
  LOCK_HOURS,
  DANGER_HOURS,
  hoursFromRoster,
  fleetHealth,
  fmtHours,
} from "../tools/drip-priority.mjs";
import { createDripRun } from "../tools/drip-run.mjs";
import { lintBeat, lintNotes, repairArtifact, formatErrors } from "../tools/beat-lint.mjs";

export const BASE = "https://gazette.sylve.org";

// ---- pure helpers (imported directly by tests/worker-drip.test.ts) --------

export const todayUTC = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// D1 rows -> the candidate shape tools/drip-run.mjs consumes. The sort reproduces the PC
// drip's flat list: the whole pantry first, then the queue, each in file order (`position`),
// with the row id as the last resort so the order is total and stable.
export function candidatesFromRows(rows) {
  const rank = (r) => (r?.origin === "pantry" ? 0 : 1);
  return (rows || [])
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .map((row) => {
      const entry = {
        handle: row.handle,
        headline: row.headline ?? "",
        body: row.body ?? "",
      };
      if (row.notes) entry.notes = row.notes;
      if (row.image_id) entry.image_id = row.image_id;
      return { entry, from: rank(row) === 0 ? "pantry" : "queue", row };
    });
}

// Everything the tick decides BEFORE it touches the network, from the three D1 reads.
//   rows        queued drip_queue rows
//   agents      [{handle, token, last_posted_at}] straight from the agents table
//   postedToday handles that already have a beat dated today (blocked for this run)
// Returns the run driver plus the token map and the silence clock the caller logs from.
export function buildRun({ rows, agents, postedToday, now = Date.now(), log = () => {} }) {
  const tokens = new Map();
  for (const a of agents || []) if (a?.handle && a.token) tokens.set(a.handle, a.token);
  // Same clock the PC drip gets from GET /api/agents, read straight from the source.
  const hoursByHandle = hoursFromRoster(agents, now);
  const run = createDripRun({
    candidates: candidatesFromRows(rows),
    hoursByHandle,
    hasToken: (h) => tokens.has(h),
    blocked: postedToday || [],
    onSkip: (handle) => log(`drip: no token for handle '${handle}', skipping`),
  });
  return { run, tokens, hoursByHandle };
}

// The POST body for a beat. Notes are PRIVATE context; a notes privacy hit rejects the WHOLE
// post server-side, so notes we cannot vouch for are dropped rather than losing a good beat.
// A legacy `project` field is never passed through (projects are gone).
export function payloadFor(entry, log = () => {}) {
  const payload = { headline: entry.headline, body: entry.body };
  if (entry.image_id) payload.image_id = entry.image_id;
  if (entry.notes) {
    const n = lintNotes(entry.notes);
    if (n.ok) payload.notes = entry.notes;
    else log(`drip: notes dropped for @${entry.handle} (${n.errors[0]?.code})`);
  }
  return payload;
}

// How a POST /api/<token>/daily response is treated:
//   "posted"     200 + {ok:true}     -> record daily_id + posted_at
//   "park"       422                 -> the beat is bad, park it with the errors
//   "handle"     429 / 404 / 403     -> the BEAT is fine, that handle sits the run out
//   "transient"  anything else (5xx) -> leave it queued, try the next candidate
export function classifyResponse(status, data) {
  if (status === 200 && data?.ok) return "posted";
  if (status === 422) return "park";
  if (status === 429 || status === 404 || status === 403) return "handle";
  return "transient";
}

// ---- the tick -------------------------------------------------------------

export async function runDrip(env, { now = Date.now(), fetchImpl, log = console.log } = {}) {
  const doFetch = fetchImpl || fetch;
  const db = env.DB;
  const today = todayUTC(now);

  // Three reads, one round-trip. `agents` is the roster (token + silence clock);
  // `postedToday` is which handles already have a beat dated today (replies excluded), the
  // same truth the PC drip reads out of GET /api/feed, only exact.
  const [agentsRes, rowsRes, todayRes] = await db.batch([
    db.prepare("SELECT handle, token, last_posted_at FROM agents"),
    db.prepare(
      `SELECT * FROM drip_queue WHERE state = 'queued'
       ORDER BY CASE origin WHEN 'pantry' THEN 0 ELSE 1 END, position, id`,
    ),
    db
      .prepare(
        `SELECT DISTINCT a.handle AS handle FROM dailies d JOIN agents a ON a.id = d.agent_id
         WHERE d.date = ? AND d.parent_id IS NULL`,
      )
      .bind(today),
  ]);

  const agents = agentsRes.results ?? [];
  const rows = rowsRes.results ?? [];
  const postedToday = (todayRes.results ?? []).map((r) => r.handle).filter(Boolean);

  if (rows.length === 0) {
    log("drip: the queue is empty, nothing to do (push more with tools/drip-push.mjs)");
    return { posted: 0, attempts: 0, parked: 0 };
  }
  log(`drip: handles posted today (dailies): [${postedToday.join(", ") || "none"}]`);

  const { run, tokens, hoursByHandle } = buildRun({ rows, agents, postedToday, now, log });
  const atRiskTop = run.eligible
    .slice(0, 3)
    .map((h) => `@${h} ${fmtHours(hoursByHandle.get(h) ?? Infinity)}`);
  log("drip: silence clock from the agents table");
  log(`drip: most at risk: ${atRiskTop.join(", ") || "none eligible"}`);
  log(
    run.catchup
      ? `drip: catch-up run, ${run.atRisk.length} handle(s) at risk (>=${DANGER_HOURS}h), posting up to ${run.budget}`
      : `drip: normal run, posting up to ${run.budget}`,
  );

  const nowISO = () => new Date().toISOString();
  let parkedCount = 0;

  const park = async (row, why, errors) => {
    await db
      .prepare(
        "UPDATE drip_queue SET state = 'parked', posted_at = NULL, error = ? WHERE id = ? AND state IN ('queued','posted')",
      )
      .bind(`${why}: ${formatErrors(errors)}`.slice(0, 2000), row.id)
      .run();
    parkedCount++;
    log(`drip: PARKED @${row.handle} (${why}) ${String(row.headline).slice(0, 60)}`);
    if (errors?.length) log(formatErrors(errors).replace(/^/gm, "  "));
  };

  // Put a claimed row back in the queue: the beat is fine, this run just cannot send it.
  const release = (row) =>
    db
      .prepare("UPDATE drip_queue SET state = 'queued', posted_at = NULL WHERE id = ? AND state = 'posted'")
      .bind(row.id)
      .run();

  for (const cand of run.picks()) {
    const { entry, row, from } = cand;

    // A path in markdown backticks does not satisfy the server's artifact rule (see
    // tools/beat-lint.mjs). Unwrap it rather than park an otherwise-good beat.
    const fix = repairArtifact(entry);
    if (fix.repaired) {
      entry.headline = fix.entry.headline;
      entry.body = fix.entry.body;
      log(`drip: unbackticked the paths in @${entry.handle}'s beat (artifact rule)`);
    }

    // Local lint first: a beat the server would 422 never costs a request.
    const local = lintBeat(entry);
    if (!local.ok) {
      run.countAttempt();
      await park(row, "local lint", local.errors);
      continue;
    }

    // CLAIM before the request. The guard (AND state = 'queued') means a concurrent or
    // retried run cannot pick the same row, and a crash between here and the response
    // leaves the beat marked posted, i.e. silently dropped rather than posted twice.
    const claim = await db
      .prepare("UPDATE drip_queue SET state = 'posted', posted_at = ?, error = NULL WHERE id = ? AND state = 'queued'")
      .bind(nowISO(), row.id)
      .run();
    if (!(claim.meta?.changes > 0)) {
      log(`drip: beat ${row.id} was claimed by another run, skipping`);
      continue;
    }

    const payload = payloadFor(entry, log);
    run.countAttempt();

    let res;
    try {
      res = await doFetch(`${BASE}/api/${tokens.get(entry.handle)}/daily`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Network failure: nothing to learn about this beat, and the next POST would fail too.
      await release(row);
      log(`drip: network failure (${err.message}), beat kept, aborting run`);
      break;
    }
    const data = await res.json().catch(() => ({}));

    switch (classifyResponse(res.status, data)) {
      case "posted": {
        await db
          .prepare("UPDATE drip_queue SET daily_id = ?, posted_at = ?, error = NULL WHERE id = ?")
          .bind(typeof data.id === "number" ? data.id : null, nowISO(), row.id)
          .run();
        const wasSilent = fmtHours(hoursByHandle.get(entry.handle) ?? Infinity);
        run.recordPost(entry.handle); // one beat per handle per run
        hoursByHandle.set(entry.handle, 0); // the clock resets, so the end-of-run health is honest
        log(
          `drip: posted @${entry.handle} from ${from} (was silent ${wasSilent}) #${data.id} ${String(entry.headline).slice(0, 80)}`,
        );
        break;
      }
      case "park": {
        const errors = data.errors || [{ code: "unknown", message: JSON.stringify(data) }];
        await park(row, "server 422", errors);
        break;
      }
      case "handle": {
        await release(row);
        run.block(entry.handle);
        log(
          `drip: @${entry.handle} unavailable (${res.status} ${data.code || ""}), beat kept, trying another handle`,
        );
        break;
      }
      default: {
        await release(row);
        log(`drip: transient failure ${res.status} @${entry.handle}, kept, trying next`);
      }
    }
  }

  if (run.posts === 0) {
    if (run.gaveUp) log(`drip: gave up after ${run.attemptCeiling} attempts, nothing posted this run`);
    else if (run.attempts === 0)
      log("drip: no eligible beat (every handle already posted today, or none queued)");
    else log(`drip: nothing posted this run (${run.attempts} attempt(s) tried)`);
  }

  // Fleet health: does the drip keep up with the 36h lock? Counted over every handle we hold
  // a token for, so a handle whose beats ran out still shows up.
  const fleet = [...tokens.keys()];
  const health = fleetHealth(hoursByHandle, fleet);
  const beatsLeft = new Set(rows.map((r) => r.handle).filter(Boolean));
  log(
    `drip: fleet health: ${health.locked.length} locked (>=${LOCK_HOURS}h), ${health.warn.length} at risk (${DANGER_HOURS}-${LOCK_HOURS}h), ${health.healthy.length} healthy of ${fleet.length}`,
  );
  if (health.locked.length) {
    log(
      `drip: WARNING locked out: ${health.locked
        .map((r) => `@${r.handle} ${fmtHours(r.hours)}${beatsLeft.has(r.handle) ? "" : " (no beats left)"}`)
        .join(", ")}`,
    );
  }
  if (health.warn.length) {
    log(`drip: at risk: ${health.warn.map((r) => `@${r.handle} ${fmtHours(r.hours)}`).join(", ")}`);
  }
  log(`drip: done, posted ${run.posts}, ${run.attempts} attempt(s), ${parkedCount} parked this run`);

  return { posted: run.posts, attempts: run.attempts, parked: parkedCount };
}

export default {
  // Cron: every 2 hours (see wrangler.toml [triggers]). A failing tick must never wedge the
  // cron, so everything is caught and logged; the next tick starts clean because no state
  // lives in the Worker.
  async scheduled(event, env, ctx) {
    const work = runDrip(env).catch((err) => {
      console.log(`drip: run failed (${err && err.message ? err.message : err})`);
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    await work;
  },
};
