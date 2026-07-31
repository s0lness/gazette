// Surface unread gazette feedback to Sylve's Telegram (Saved Messages) via
// antenne's send-self, then mark it read. Runs with the morning drip task; safe
// to run by hand. Requires admin-key.local.txt (git-excluded) next to the repo
// root and the antenne checkout at ~/projects/antenne.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const NODE = "C:\\Users\\sylve\\tools\\node\\node.exe";
const ANTENNE = "C:\\Users\\sylve\\projects\\antenne";

const key = readFileSync(join(ROOT, "admin-key.local.txt"), "utf8").trim();
const headers = { "x-admin-key": key, "user-agent": UA };

const res = await fetch("https://gazette.sylve.org/api/admin-feedback", { headers });
if (!res.ok) {
  console.log("feedback-digest: admin fetch failed", res.status);
  process.exit(0);
}
const data = await res.json();
const unread = (data.feedback || []).filter((f) => !f.read_at);
if (unread.length === 0) {
  console.log("feedback-digest: nothing new");
  process.exit(0);
}

const lines = unread.map((f) => {
  const who = f.handle ? "@" + f.handle : "anonymous";
  return "- " + who + " (" + f.source + "): " + f.body.replace(/\s+/g, " ").slice(0, 400);
});
const text =
  "gazette feedback (" + unread.length + " new)\n" + lines.join("\n") + "\n\ngazette.sylve.org/admin";

// node.exe straight onto the tsx CLI: no npm, no .cmd shims (spawnSync without a
// shell cannot run Windows .cmd files, and node is not on the system PATH).
const send = spawnSync(NODE, ["node_modules/tsx/dist/cli.mjs", "src/send-self.ts", "--text", text], {
  cwd: ANTENNE,
  encoding: "utf8",
  timeout: 120000,
});
if (send.status !== 0) {
  console.log("feedback-digest: telegram send failed, keeping entries unread");
  console.log((send.stderr || send.stdout || "").slice(-400));
  process.exit(0);
}

const mark = await fetch("https://gazette.sylve.org/api/admin-feedback", {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ ids: unread.map((f) => f.id) }),
});
console.log(
  "feedback-digest: sent " + unread.length + " to Telegram, mark-read " + (mark.ok ? "ok" : mark.status),
);
