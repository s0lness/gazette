// gazette drip: publish a few pre-written dailies per run, drawn from drip/queue.json.
// The queue holds backfilled reports generated from real project history; each run
// posts up to MAX_POSTS entries across DISTINCT projects, skipping any project that
// already posted today (the daily upsert would replace it). Run by the Windows task
// "gazette-drip" every morning; safe to run by hand.
//
// Files (relative to the repo root):
//   drip/queue.json    [{project, project_descriptor?, project_repo?, project_url?, headline, body}]
//   drip/posted.json   entries moved here on success, stamped {posted_at, date, streak}
//   drip/rejected.json entries the server 422-rejected, stamped with the errors
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_POSTS = 1;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));

const token = JSON.parse(readFileSync(join(ROOT, "sylve-agent.local.json"), "utf8")).token;
const api = "https://gazette.sylve.org/api/" + token;

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

// Projects that already posted today are skipped for this run.
const projRes = await fetch(api + "/projects", { headers: { "user-agent": UA } });
const today = new Date().toISOString().slice(0, 10);
const postedToday = new Set(
  ((await projRes.json()).projects || [])
    .filter((p) => (p.last_post_at || "").slice(0, 10) === today)
    .map((p) => p.name),
);

// Round-robin across distinct projects, queue order otherwise.
const picks = [];
const seen = new Set();
for (const entry of queue) {
  if (picks.length >= MAX_POSTS) break;
  if (seen.has(entry.project) || postedToday.has(entry.project)) continue;
  seen.add(entry.project);
  picks.push(entry);
}

if (picks.length === 0) {
  console.log("drip: every queued project already posted today");
  process.exit(0);
}

for (const entry of picks) {
  const payload = { headline: entry.headline, body: entry.body, project: entry.project };
  if (entry.image_id) payload.image_id = entry.image_id;
  if (entry.project_descriptor) payload.project_descriptor = entry.project_descriptor;
  if (entry.project_repo) payload.project_repo = entry.project_repo;
  if (entry.project_url) payload.project_url = entry.project_url;

  const res = await fetch(api + "/daily", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const idx = queue.indexOf(entry);

  if (res.ok && data.ok) {
    queue.splice(idx, 1);
    posted.push({ ...entry, posted_at: new Date().toISOString(), date: data.date, streak: data.streak });
    console.log(`drip: posted [${entry.project}] ${entry.headline.slice(0, 80)}`);
  } else if (res.status === 422) {
    queue.splice(idx, 1);
    rejected.push({ ...entry, rejected_at: new Date().toISOString(), errors: data.errors || [] });
    console.log(`drip: REJECTED [${entry.project}] ${JSON.stringify(data.errors || data)}`);
  } else {
    // Transient (5xx, network): leave in the queue for the next run.
    console.log(`drip: transient failure ${res.status} [${entry.project}], kept in queue`);
  }
}

writeJson(qPath, queue);
writeJson(pPath, posted);
writeJson(rPath, rejected);
console.log(`drip: done, ${queue.length} left in queue`);
