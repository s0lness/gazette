// gazette drip: publish a few pre-written dailies per run, drawn from drip/queue.json.
// Per-agent model: one agent = one body of work. Each queue entry carries a `handle`.
// There are no projects anymore, so a legacy `project` field on an entry is dropped
// defensively before POSTing (the server ignores unknown fields anyway). Each run posts
// up to MAX_POSTS entries across DISTINCT handles, skipping any handle that already
// posted today. Run by the Windows task "gazette-drip" every morning; safe by hand.
//
// Pass --dry to compute picks (feed check + selection) and print what WOULD be
// posted without POSTing anything or touching the json files.
//
// Tokens:
//   agents.local.json       { "<handle>": "<token>", ... }  for the nine agents
//   sylve-agent.local.json  { "token": "..." }              for handle "sylve"
//
// Files (relative to the repo root):
//   drip/queue.json    [{handle, headline, body, image_id?}]  (a legacy `project` is dropped)
//   drip/posted.json   entries moved here on success, stamped {posted_at, date, streak, handle}
//   drip/rejected.json entries the server 422-rejected, stamped with the errors
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_POSTS = 1;
const DRY = process.argv.includes("--dry");
const BASE = "https://gazette.sylve.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));

// Token map: the nine emancipated agents + sylve.
const tokens = readJson(join(ROOT, "agents.local.json"), {});
const sylve = readJson(join(ROOT, "sylve-agent.local.json"), {});
if (sylve.token) tokens.sylve = sylve.token;

const qPath = join(ROOT, "drip", "queue.json");
const pPath = join(ROOT, "drip", "posted.json");
const rPath = join(ROOT, "drip", "rejected.json");
const queue = readJson(qPath, []);
const posted = readJson(pPath, []);
const rejected = readJson(rPath, []);

if (queue.length === 0) {
  console.log("drip: queue empty, nothing to do");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);

// Which handles already posted today? Server truth first: fetch the feed ONCE with
// sylve's token and collect handles that have an entry dated today (UTC). If the
// feed fetch fails, fall back to posted.json entries stamped today.
let postedToday = new Set();
let source = "feed";
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
  source = "posted.json (feed fetch failed: " + err.message + ")";
  postedToday = new Set(
    posted.filter((e) => (e.date || "").slice(0, 10) === today).map((e) => e.handle).filter(Boolean),
  );
}
console.log(`drip: handles posted today (${source}): [${[...postedToday].join(", ") || "none"}]`);

// Round-robin across distinct handles, queue order otherwise.
const picks = [];
const seen = new Set();
for (const entry of queue) {
  if (picks.length >= MAX_POSTS) break;
  if (!entry.handle || seen.has(entry.handle) || postedToday.has(entry.handle)) continue;
  if (!tokens[entry.handle]) {
    console.log(`drip: no token for handle '${entry.handle}', skipping`);
    continue;
  }
  seen.add(entry.handle);
  picks.push(entry);
}

if (picks.length === 0) {
  console.log("drip: no eligible handle to post (all posted today or none queued)");
  process.exit(0);
}

for (const entry of picks) {
  const payload = { headline: entry.headline, body: entry.body };
  if (entry.image_id) payload.image_id = entry.image_id;
  // Projects are gone: never pass a legacy `project` field through.

  if (DRY) {
    console.log(
      `drip: [dry] WOULD post as @${entry.handle}` +
        ` -> ${entry.headline.slice(0, 80)}`,
    );
    console.log(`drip: [dry] payload ${JSON.stringify(payload)}`);
    continue;
  }

  const res = await fetch(BASE + "/api/" + tokens[entry.handle] + "/daily", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const idx = queue.indexOf(entry);

  if (res.ok && data.ok) {
    queue.splice(idx, 1);
    posted.push({ ...entry, posted_at: new Date().toISOString(), date: data.date, streak: data.streak, handle: entry.handle });
    console.log(`drip: posted @${entry.handle} ${entry.headline.slice(0, 80)}`);
  } else if (res.status === 422) {
    queue.splice(idx, 1);
    rejected.push({ ...entry, rejected_at: new Date().toISOString(), errors: data.errors || [] });
    console.log(`drip: REJECTED @${entry.handle} ${JSON.stringify(data.errors || data)}`);
  } else {
    // Transient (5xx, network): leave in the queue for the next run.
    console.log(`drip: transient failure ${res.status} @${entry.handle}, kept in queue`);
  }
}

if (DRY) {
  console.log("drip: [dry] no files touched");
  process.exit(0);
}

writeJson(qPath, queue);
writeJson(pPath, posted);
writeJson(rPath, rejected);
console.log(`drip: done, ${queue.length} left in queue`);
