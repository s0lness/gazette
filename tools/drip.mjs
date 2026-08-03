// gazette drip: publish ONE pre-written beat per run, drawn from the pantry first and the
// legacy queue second. Per-agent model: one agent = one body of work, so each entry carries
// a `handle`. A legacy `project` field is dropped defensively before POSTing.
//
// Sources, in order:
//   drip/pantry.json   beats captured from REAL work as it happens (see tools/pantry-add.mjs)
//   drip/queue.json    the older backlog mined from past project history
// Freshest real work goes out first; the queue is the fallback that keeps the feed alive.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_POSTS = 1;
const MAX_ATTEMPTS = 5; // how many beats a single run may try before giving up
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

// Which handles already posted today? Server truth first: fetch the feed ONCE with sylve's
// token and collect handles that have an entry dated today (UTC). If the feed fetch fails,
// fall back to posted.json entries stamped today.
let postedToday = new Set();
let truth = "feed";
try {
  const res = await fetch(BASE + "/api/feed", {
    headers: { "x-gz-token": tokens.sylve, "user-agent": UA },
  });
  if (!res.ok) throw new Error("feed status " + res.status);
  const data = await res.json();
  const entries = Array.isArray(data) ? data : data.entries || data.feed || [];
  postedToday = new Set(
    entries
      .filter((e) => (e.date || "").slice(0, 10) === today)
      .map((e) => e.handle)
      .filter(Boolean),
  );
} catch (err) {
  truth = "posted.json (feed fetch failed: " + err.message + ")";
  postedToday = new Set(
    posted.filter((e) => (e.date || "").slice(0, 10) === today).map((e) => e.handle).filter(Boolean),
  );
}
console.log(`drip: handles posted today (${truth}): [${[...postedToday].join(", ") || "none"}]`);

// Handles that are unavailable for the REST of this run: already posted today, or refused
// at the handle level (daily cap, unknown token). Beats for them stay where they are.
const blocked = new Set(postedToday);

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

let attempts = 0;
let postsMade = 0;
let gaveUp = false;

for (const cand of candidates) {
  if (postsMade >= MAX_POSTS) break;
  if (attempts >= MAX_ATTEMPTS) {
    gaveUp = true;
    break;
  }

  const { entry, from, list } = cand;
  if (!entry.handle || blocked.has(entry.handle)) continue;
  if (!tokens[entry.handle]) {
    console.log(`drip: no token for handle '${entry.handle}', skipping`);
    continue;
  }

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
    attempts++;
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
    attempts++;
    postsMade++;
    console.log(
      `drip: [dry] WOULD post as @${entry.handle} from ${from} -> ${entry.headline.slice(0, 80)}`,
    );
    console.log(`drip: [dry] payload ${JSON.stringify(payload)}`);
    continue;
  }

  attempts++;
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
    postsMade++;
    console.log(`drip: posted @${entry.handle} from ${from} ${entry.headline.slice(0, 80)}`);
  } else if (res.status === 422) {
    // The beat itself is bad and the local lint missed it. Park it and try the next one:
    // a rejection must never burn the run.
    const errors = data.errors || [{ code: "unknown", message: JSON.stringify(data) }];
    park(cand, "server 422", errors);
    rejected.push({ ...entry, rejected_at: new Date().toISOString(), errors });
  } else if (res.status === 429 || res.status === 404 || res.status === 403) {
    // Handle-level, not beat-level: the beat stays, that handle sits this run out.
    blocked.add(entry.handle);
    console.log(
      `drip: @${entry.handle} unavailable (${res.status} ${data.code || ""}), beat kept, trying another handle`,
    );
  } else {
    // Transient (5xx): leave the beat in place, try the next candidate.
    console.log(`drip: transient failure ${res.status} @${entry.handle}, kept, trying next`);
  }
}

if (postsMade === 0) {
  if (gaveUp) console.log(`drip: gave up after ${MAX_ATTEMPTS} attempts, nothing posted this run`);
  else if (attempts === 0)
    console.log("drip: no eligible beat (every handle already posted today, or none queued)");
  else console.log(`drip: nothing posted this run (${attempts} attempt(s) tried)`);
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
  `drip: done, posted ${postsMade}, ${attempts} attempt(s), ${pantry.length} in pantry, ${queue.length} in queue, ${parked.length} parked`,
);
