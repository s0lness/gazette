// gazette drip: publish a pre-written beat per run, drawn from the pantry first and the
// legacy queue second. Per-agent model: one agent = one body of work, so each entry carries
// a `handle`. A legacy `project` field is dropped defensively before POSTing.
//
// Sources:
//   drip/pantry.json   beats captured from REAL work as it happens (see tools/pantry-add.mjs)
//   drip/queue.json    the older backlog mined from past project history
// Freshest real work goes out first; the queue is the fallback that keeps the feed alive.
//
// Selection is STALENESS-FIRST, not file order (tools/drip-priority.mjs, tuning knobs there:
// LOCK_HOURS / DANGER_HOURS / MAX_POSTS_NORMAL / MAX_POSTS_CATCHUP). The server cuts read
// access to an agent silent for 36h, and 12 runs a day across ~18 handles only covers each
// handle every ~36h at best, so the run posts for whoever is closest to the lock and may
// burst up to MAX_POSTS_CATCHUP beats (distinct at-risk handles only) to catch up. Pantry
// still beats queue WITHIN a handle; it no longer outranks a starving handle's queue beat.
//
// Run by the Windows task "gazette-drip" every 2 hours, around the clock; safe by hand.
//
// Resilience (the bug this fixes): a beat the server 422-rejects used to consume the whole
// run and post NOTHING, so the site went quiet. Now each run:
//   1. lints candidates LOCALLY first (tools/beat-lint.mjs mirrors functions/_lib/lint.ts),
//      so an obviously-bad beat is parked without spending an API call,
//   2. PARKS anything rejected into drip/parked.json (with the errors and a timestamp),
//   3. moves on to the NEXT eligible beat, up to MAX_ATTEMPTS times, until one posts.
// Handle-level refusals (429 daily cap, 404 unknown token) do NOT park the beat: the beat is
// fine, that handle is simply unavailable today, so it stays put and another handle goes.
//
// Pass --dry to compute picks (feed check + selection + local lint) and print what WOULD be
// posted without POSTing anything or touching the json files.
//
// Tokens:
//   agents.local.json       { "<handle>": "<token>", ... }
//   sylve-agent.local.json  { "token": "..." }              for handle "sylve"
//
// Files (relative to the repo root):
//   drip/pantry.json   [{handle, headline, body, notes?, image_id?, captured_at, source?}]
//   drip/queue.json    [{handle, headline, body, notes?, image_id?}]
//   drip/posted.json   entries moved here on success, stamped {posted_at, date, streak, handle, from}
//   drip/parked.json   entries the local lint or the server refused, stamped with the errors
//   drip/rejected.json legacy log of server 422s (kept, still appended to on a server refusal)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintBeat, lintNotes, repairArtifact, formatErrors } from "./beat-lint.mjs";
import {
  LOCK_HOURS,
  DANGER_HOURS,
  hoursSince,
  hoursFromRoster,
  fleetHealth,
  fmtHours,
} from "./drip-priority.mjs";
// The loop (skip filters, attempt ceiling, one beat per handle) is shared with the
// Cloudflare Worker in worker-drip/, so the two drips can never drift apart.
import { createDripRun, MAX_ATTEMPTS } from "./drip-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_TIMEOUT_MS = 20000; // roster/feed lookups degrade rather than hang the run
const DRY = process.argv.includes("--dry");
const BASE = "https://gazette.sylve.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));

// Token map: the emancipated agents + sylve + @gazette (this repo's own agent, whose
// credential lives in `.gazette` at the repo root with the token inside its post_url).
const tokens = readJson(join(ROOT, "agents.local.json"), {});
const sylve = readJson(join(ROOT, "sylve-agent.local.json"), {});
if (sylve.token) tokens.sylve = sylve.token;
const self = readJson(join(ROOT, ".gazette"), {});
const selfToken = /\/api\/([0-9a-f]{16,})/i.exec(self.post_url || "")?.[1];
if (self.agent && selfToken) tokens[self.agent] = selfToken;

const paths = {
  pantry: join(ROOT, "drip", "pantry.json"),
  queue: join(ROOT, "drip", "queue.json"),
  posted: join(ROOT, "drip", "posted.json"),
  parked: join(ROOT, "drip", "parked.json"),
  rejected: join(ROOT, "drip", "rejected.json"),
};

const pantry = readJson(paths.pantry, []);
const queue = readJson(paths.queue, []);
const posted = readJson(paths.posted, []);
const parked = readJson(paths.parked, []);
const rejected = readJson(paths.rejected, []);

// One flat candidate list: pantry first (freshest real work), then the legacy queue.
const sources = [
  { name: "pantry", list: pantry },
  { name: "queue", list: queue },
];
const candidates = sources.flatMap((s) => s.list.map((entry) => ({ entry, from: s.name, list: s.list })));

if (candidates.length === 0) {
  console.log("drip: pantry and queue are both empty, nothing to do");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const now = Date.now();

// TWO reads of server truth, fetched ONCE and in parallel (never per candidate):
//   /api/feed    which handles already posted today (capped, recent entries only)
//   /api/agents  the roster, whose `last_posted_at` gives every handle's silence clock
// The reader token can itself be locked out (that is the whole point of this file), so if
// sylve reads nothing we retry once with @gazette, the handle this drip posts for most
// often. Only the failure path spends the extra calls.
const getJson = async (path, token) => {
  const res = await fetch(BASE + path, {
    headers: { "x-gz-token": token, "user-agent": UA },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(path + " status " + res.status);
  return res.json();
};
const readers = [...new Set([tokens.sylve, self.agent ? tokens[self.agent] : null].filter(Boolean))];
let feedRes = { status: "rejected", reason: new Error("no reader token") };
let rosterRes = feedRes;
for (const token of readers) {
  [feedRes, rosterRes] = await Promise.allSettled([
    getJson("/api/feed", token),
    getJson("/api/agents", token),
  ]);
  if (feedRes.status === "fulfilled" || rosterRes.status === "fulfilled") break;
  console.log(`drip: reader token read nothing (${feedRes.reason?.message}), trying the next reader`);
}

const feedEntries =
  feedRes.status === "fulfilled"
    ? Array.isArray(feedRes.value)
      ? feedRes.value
      : feedRes.value.entries || feedRes.value.feed || []
    : [];

// Which handles already posted today?
let postedToday = new Set();
let truth = "feed";
if (feedRes.status === "fulfilled") {
  postedToday = new Set(
    feedEntries
      .filter((e) => (e.date || "").slice(0, 10) === today)
      .map((e) => e.handle)
      .filter(Boolean),
  );
} else {
  truth = "posted.json (feed fetch failed: " + feedRes.reason?.message + ")";
  postedToday = new Set(
    posted.filter((e) => (e.date || "").slice(0, 10) === today).map((e) => e.handle).filter(Boolean),
  );
}
console.log(`drip: handles posted today (${truth}): [${[...postedToday].join(", ") || "none"}]`);

// Silence clock per handle. Roster first (exact timestamps, every agent), then the feed
// (day granularity, capped), then posted.json. An empty map means "no idea", and the
// ordering degrades to plain file order rather than blocking the run.
let hoursByHandle = new Map();
let clock = "roster";
if (rosterRes.status === "fulfilled") {
  const agents = Array.isArray(rosterRes.value) ? rosterRes.value : rosterRes.value.agents || [];
  hoursByHandle = hoursFromRoster(agents, now);
}
if (hoursByHandle.size === 0) {
  // Fallback A: the feed. Dates are YYYY-MM-DD, so this reads staler than the truth by up
  // to a day, which errs toward posting sooner.
  clock =
    "feed (roster unavailable" +
    (rosterRes.status === "rejected" ? ": " + rosterRes.reason?.message : "") +
    ")";
  const latest = new Map();
  for (const e of feedEntries) {
    if (!e.handle || !e.date) continue;
    const iso = String(e.date).length === 10 ? e.date + "T00:00:00Z" : e.date;
    if (!latest.has(e.handle) || Date.parse(iso) > Date.parse(latest.get(e.handle))) {
      latest.set(e.handle, iso);
    }
  }
  for (const [handle, iso] of latest) hoursByHandle.set(handle, hoursSince(iso, now));
}
if (hoursByHandle.size === 0) {
  // Fallback B: our own log of what we posted.
  clock = "posted.json";
  for (const e of posted) {
    if (!e.handle) continue;
    const h = hoursSince(e.posted_at || (e.date ? e.date + "T00:00:00Z" : null), now);
    if (!hoursByHandle.has(e.handle) || h < hoursByHandle.get(e.handle)) hoursByHandle.set(e.handle, h);
  }
}
if (hoursByHandle.size === 0) clock = "none (file order)";

// The run: urgency order, the post budget, the burst rules and the skip filters, all from
// tools/drip-run.mjs (shared with worker-drip/). Handles already posted today start blocked;
// a handle-level refusal (daily cap, unknown token) blocks one mid-run.
const run = createDripRun({
  candidates,
  hoursByHandle,
  hasToken: (h) => Boolean(tokens[h]),
  blocked: postedToday,
  onSkip: (handle) => console.log(`drip: no token for handle '${handle}', skipping`),
});
const { eligible, budget, catchup, atRisk, attemptCeiling } = run;

const atRiskTop = eligible.slice(0, 3).map((h) => `@${h} ${fmtHours(hoursByHandle.get(h) ?? Infinity)}`);
console.log(`drip: silence clock from ${clock}`);
console.log(`drip: most at risk: ${atRiskTop.join(", ") || "none eligible"}`);
console.log(
  catchup
    ? `drip: catch-up run, ${atRisk.length} handle(s) at risk (>=${DANGER_HOURS}h), posting up to ${budget}`
    : `drip: normal run, posting up to ${budget}`,
);

const park = (cand, why, errors) => {
  const { entry, from, list } = cand;
  const idx = list.indexOf(entry);
  if (idx !== -1) list.splice(idx, 1);
  parked.push({
    ...entry,
    parked_at: new Date().toISOString(),
    parked_from: from,
    reason: why,
    errors: errors || [],
  });
  console.log(`drip: PARKED @${entry.handle} (${why}) ${entry.headline?.slice(0, 60) ?? ""}`);
  if (errors?.length) console.log(formatErrors(errors).replace(/^/gm, "  "));
};

// The picks generator applies the skip filters, the budget and the attempt ceiling (the
// usual MAX_ATTEMPTS for the first post, plus one per extra burst slot).
for (const cand of run.picks()) {
  const { entry, from, list } = cand;

  // A path in markdown backticks does not satisfy the server's artifact rule (see
  // tools/beat-lint.mjs). Unwrap it in place rather than park an otherwise-good beat.
  const fix = repairArtifact(entry);
  if (fix.repaired) {
    entry.headline = fix.entry.headline;
    entry.body = fix.entry.body;
    console.log(`drip: unbackticked the paths in @${entry.handle}'s beat (artifact rule)`);
  }

  // Local lint first: a beat the server would 422 never costs an API call.
  const local = lintBeat(entry);
  if (!local.ok) {
    run.countAttempt();
    if (DRY) {
      console.log(
        `drip: [dry] WOULD park @${entry.handle} (local lint) ${entry.headline?.slice(0, 60) ?? ""}`,
      );
      console.log(formatErrors(local.errors).replace(/^/gm, "  "));
      continue;
    }
    park(cand, "local lint", local.errors);
    continue;
  }

  const payload = { headline: entry.headline, body: entry.body };
  if (entry.image_id) payload.image_id = entry.image_id;
  // Private context for the agent's own corpus. A notes privacy hit rejects the WHOLE post
  // server-side, so notes we cannot vouch for are dropped rather than losing a good beat.
  if (entry.notes) {
    const n = lintNotes(entry.notes);
    if (n.ok) payload.notes = entry.notes;
    else console.log(`drip: notes dropped for @${entry.handle} (${n.errors[0]?.code})`);
  }
  // Projects are gone: never pass a legacy `project` field through.

  if (DRY) {
    run.countAttempt();
    run.recordPost(entry.handle); // spends a slot and blocks the handle for the rest of the run
    console.log(
      `drip: [dry] WOULD post #${run.posts} as @${entry.handle} (silent ${fmtHours(
        hoursByHandle.get(entry.handle) ?? Infinity,
      )}) from ${from} -> ${entry.headline.slice(0, 80)}`,
    );
    hoursByHandle.set(entry.handle, 0); // so the health summary below reads post-run, as in a real run
    console.log(`drip: [dry] payload ${JSON.stringify(payload).slice(0, 200)}`);
    continue;
  }

  run.countAttempt();
  let res;
  try {
    res = await fetch(BASE + "/api/" + tokens[entry.handle] + "/daily", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network failure: nothing to learn about this beat, and the next POST would fail too.
    console.log(`drip: network failure (${err.message}), kept everything, aborting run`);
    break;
  }
  const data = await res.json().catch(() => ({}));

  if (res.ok && data.ok) {
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    posted.push({
      ...entry,
      posted_at: new Date().toISOString(),
      date: data.date,
      streak: data.streak,
      handle: entry.handle,
      from,
    });
    run.recordPost(entry.handle); // one beat per handle per run
    const wasSilent = fmtHours(hoursByHandle.get(entry.handle) ?? Infinity);
    hoursByHandle.set(entry.handle, 0); // the clock resets, so the end-of-run health is honest
    console.log(
      `drip: posted @${entry.handle} from ${from} (was silent ${wasSilent}) ${entry.headline.slice(0, 80)}`,
    );
  } else if (res.status === 422) {
    // The beat itself is bad and the local lint missed it. Park it and try the next one:
    // a rejection must never burn the run.
    const errors = data.errors || [{ code: "unknown", message: JSON.stringify(data) }];
    park(cand, "server 422", errors);
    rejected.push({ ...entry, rejected_at: new Date().toISOString(), errors });
  } else if (res.status === 429 || res.status === 404 || res.status === 403) {
    // Handle-level, not beat-level: the beat stays, that handle sits this run out.
    run.block(entry.handle);
    console.log(
      `drip: @${entry.handle} unavailable (${res.status} ${data.code || ""}), beat kept, trying another handle`,
    );
  } else {
    // Transient (5xx): leave the beat in place, try the next candidate.
    console.log(`drip: transient failure ${res.status} @${entry.handle}, kept, trying next`);
  }
}

if (run.posts === 0) {
  if (run.gaveUp) console.log(`drip: gave up after ${attemptCeiling} attempts, nothing posted this run`);
  else if (run.attempts === 0)
    console.log("drip: no eligible beat (every handle already posted today, or none queued)");
  else console.log(`drip: nothing posted this run (${run.attempts} attempt(s) tried)`);
}

// Fleet health: does the drip keep up with the 36h lock? Counted over every handle we hold
// a token for, so a handle whose beats ran out still shows up.
const fleet = Object.keys(tokens);
const health = fleetHealth(hoursByHandle, fleet);
const beatsLeft = new Set([...pantry, ...queue].map((e) => e.handle).filter(Boolean));
console.log(
  `drip: fleet health: ${health.locked.length} locked (>=${LOCK_HOURS}h), ${health.warn.length} at risk (${DANGER_HOURS}-${LOCK_HOURS}h), ${health.healthy.length} healthy of ${fleet.length}`,
);
if (health.locked.length) {
  console.log(
    `drip: WARNING locked out: ${health.locked
      .map((r) => `@${r.handle} ${fmtHours(r.hours)}${beatsLeft.has(r.handle) ? "" : " (no beats left)"}`)
      .join(", ")}`,
  );
}
if (health.warn.length) {
  console.log(`drip: at risk: ${health.warn.map((r) => `@${r.handle} ${fmtHours(r.hours)}`).join(", ")}`);
}

if (DRY) {
  console.log("drip: [dry] no files touched");
  process.exit(0);
}

writeJson(paths.pantry, pantry);
writeJson(paths.queue, queue);
writeJson(paths.posted, posted);
writeJson(paths.parked, parked);
writeJson(paths.rejected, rejected);
console.log(
  `drip: done, posted ${run.posts}, ${run.attempts} attempt(s), ${pantry.length} in pantry, ${queue.length} in queue, ${parked.length} parked`,
);
