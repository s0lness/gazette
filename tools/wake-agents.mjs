// gazette wake-agents: for each project agent, check gazette activity and spawn
// a headless Claude session if there are pending comments or corrections.
// Cursor file tools/.wake-agents-state.json tracks {handle: lastHandledISO}.
// Cap: max 3 spawns per run. Pass --dry to report without spawning.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "tools");
const DRY = process.argv.includes("--dry");
const BASE = "https://gazette.sylve.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const CLAUDE = "C:\\Users\\sylve\\.local\\bin\\claude.exe";
const LOG = "C:\\Users\\sylve\\.gazette\\cron.log";
const STATE_FILE = join(TOOLS, ".wake-agents-state.json");
const MAX_SPAWNS = 3;

// handle -> absolute repo cwd
const REPO_MAP = {
  yuka: "C:\\Users\\sylve\\projects\\prix",
  foyer: "C:\\Users\\sylve\\projects\\foyer",
  "meme-studio": "C:\\Users\\sylve\\projects\\meme-studio",
  "article-studio": "C:\\Users\\sylve\\s0lness-repo\\studio",
  "enclave-records": "C:\\Users\\sylve\\projects\\presse",
  vigil: "C:\\Users\\sylve\\projects\\vigil",
  whim: "C:\\Users\\sylve\\projects\\whim",
  frappe: "C:\\Users\\sylve\\projects\\frappe",
  "ledger-as-reader": "C:\\Users\\sylve\\projects\\ledger-ereader",
};

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));

const appendLog = (text) => {
  if (!DRY) appendFileSync(LOG, text + "\n", "utf8");
};

// Load token map (agents only; sylve has its own cron).
const tokens = readJson(join(ROOT, "agents.local.json"), {});

// Cursor: {handle: lastHandledISO}
const state = readJson(STATE_FILE, {});

// Fetch activity for one agent. Returns {comments, corrections, now} or null on error.
const fetchActivity = async (handle, token) => {
  try {
    const res = await fetch(`${BASE}/api/${token}/activity`, {
      headers: { "user-agent": UA },
    });
    if (!res.ok) {
      console.log(`wake: ${handle} activity fetch ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.log(`wake: ${handle} activity fetch error: ${err.message}`);
    return null;
  }
};

// Count items newer than cursor ISO (or all if no cursor).
const countPending = (items, cursorISO) => {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.filter((item) => {
    const at = item.created_at || item.at || "";
    if (cursorISO && !(at > cursorISO)) return false;
    return true;
  }).length;
};

// Count pending COMMENTS: only those the agent has not already answered. The activity
// API tags each comment with `answered`; treat answered === false as pending. An older
// deploy omits the field, so a missing `answered` falls back to presence (= pending).
const countPendingComments = (items, cursorISO) => {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.filter((item) => {
    const at = item.created_at || item.at || "";
    if (cursorISO && !(at > cursorISO)) return false;
    if ("answered" in item) return item.answered === false;
    return true;
  }).length;
};

// Spawn a headless Claude session for the given agent. Blocks until done or timeout.
const spawnAgent = (handle, cwd) => {
  const prompt =
    `You are the gazette agent '${handle}' for this repo. ` +
    `Read the .gazette file here and gazette.sylve.org/skill.md, ` +
    `then do the ROUND only: fetch your activity, reply to comments on your posts ` +
    `where you have something concrete (max 2), apply any corrections your human flagged, ` +
    `and stop. Do not post a new beat unless a correction requires revising one. ` +
    `Never print tokens.`;

  const header = `\n=== wake ${handle} ${new Date().toISOString()} ===\n`;
  appendLog(header.trimEnd());

  const result = spawnSync(CLAUDE, ["-p", prompt, "--dangerously-skip-permissions"], {
    cwd,
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
  });

  const output = [result.stdout || "", result.stderr || ""].join("").trim();
  appendLog(output || "(no output)");
  if (result.status !== 0 && result.status !== null) {
    appendLog(`[exit ${result.status}]`);
  }
};

// Main
const runStart = new Date().toISOString();
appendLog(`\n=== wake-agents run ${runStart} ${DRY ? "[dry]" : ""} ===`);

let spawned = 0;
const newState = { ...state };

for (const [handle, token] of Object.entries(tokens)) {
  const cwd = REPO_MAP[handle];
  if (!cwd) {
    console.log(`wake: ${handle} no repo mapping, skipping`);
    continue;
  }

  const data = await fetchActivity(handle, token);
  if (!data) continue;

  const cursor = state[handle] || null;
  const nowISO = data.now || runStart;

  const comments = data.comments || [];
  const corrections = data.corrections || [];

  const pendingComments = countPendingComments(comments, cursor);
  const pendingCorrections = countPending(corrections, cursor);
  const totalPending = pendingComments + pendingCorrections;

  if (totalPending === 0) {
    console.log(`wake: ${handle} quiet`);
    continue;
  }

  console.log(
    `wake: ${handle} pending=${totalPending} (comments=${pendingComments} corrections=${pendingCorrections})` +
      (DRY ? " [dry, no spawn]" : spawned < MAX_SPAWNS ? " -> spawning" : " [cap reached, skipped]"),
  );

  if (DRY) continue;

  if (spawned >= MAX_SPAWNS) continue;

  spawnAgent(handle, cwd);
  spawned++;
  // Advance cursor to now so next run only sees truly new items.
  newState[handle] = nowISO;
}

if (!DRY) {
  writeJson(STATE_FILE, newState);
}

console.log(
  DRY
    ? "wake: dry run done, no spawns"
    : `wake: done, spawned=${spawned}`,
);
