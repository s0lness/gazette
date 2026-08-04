// Deploy gazette-drip through the Cloudflare REST API (wrangler cannot be installed on this
// machine, and the house rule is API/git deploys anyway). Same shape as ../../vigil/scripts/deploy.mjs.
//
//   bun worker-drip/deploy.mjs           # bundle + upload + D1 binding + cron + observability
//   bun worker-drip/deploy.mjs --dry     # bundle only, print what WOULD be sent
//
// It does three calls, all documented in README.md with their curl equivalents:
//   PUT  /accounts/<acct>/workers/scripts/gazette-drip            script + metadata (bindings)
//   PUT  /accounts/<acct>/workers/scripts/gazette-drip/schedules  the cron trigger
//   POST /accounts/<acct>/workers/scripts/gazette-drip/subdomain  keep it off workers.dev
//
// PREREQUISITE: migrations/0027_drip_queue.sql applied to the live D1, and the Windows task
// "gazette-drip" DISABLED (never run both, they would double-post).
//
// The token is read from ~/projects/.secrets.env and never printed.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCRIPT = "gazette-drip";
const COMPATIBILITY_DATE = "2026-01-01";
const CRON = "0 */2 * * *";
const DATABASE_ID = "6abd6020-3085-4782-8234-d6f2156f23a9";
const DRY = process.argv.includes("--dry");

function secret(name) {
  for (const p of [join(ROOT, ".secrets.env"), join(homedir(), "projects", ".secrets.env")]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    if (m) return m[1].trim();
  }
  if (process.env[name]) return process.env[name];
  throw new Error(`${name} not found in .secrets.env (project or global) or the environment`);
}

// 1. Bundle. index.js imports the shared selection logic from ../tools, so the upload needs
//    one self-contained module.
mkdirSync(join(HERE, "dist"), { recursive: true });
const build = spawnSync(
  "bun",
  ["build", join(HERE, "index.js"), "--target=browser", "--format=esm", "--outfile", join(HERE, "dist", "worker.mjs")],
  { stdio: "inherit", shell: true },
);
if (build.status !== 0) throw new Error("bun build failed");
const code = readFileSync(join(HERE, "dist", "worker.mjs"), "utf8");
console.log(`deploy: bundled ${code.length} bytes`);

const metadata = {
  main_module: "worker.mjs",
  compatibility_date: COMPATIBILITY_DATE,
  // NOTE the wire key is `id`, NOT `database_id` (that name is wrangler-config only).
  bindings: [{ type: "d1", name: "DB", id: DATABASE_ID }],
  observability: { enabled: true, head_sampling_rate: 1 },
};

if (DRY) {
  console.log("deploy: [dry] metadata", JSON.stringify(metadata, null, 2));
  console.log(`deploy: [dry] cron ${CRON}, nothing uploaded`);
  process.exit(0);
}

const TOKEN = secret("CLOUDFLARE_API_TOKEN");
const ACCOUNT = secret("CLOUDFLARE_ACCOUNT_ID");
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`;
const scrub = (text) => String(text).split(TOKEN).join("<redacted>");

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) throw new Error(scrub(`${path}: ${JSON.stringify(body.errors ?? body)}`));
  return body.result;
}

// 2. Upload the module worker with the D1 binding.
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
await cf(`/scripts/${SCRIPT}`, { method: "PUT", body: form });
console.log(`deploy: uploaded ${SCRIPT}`);

// 3. The cron trigger. PUT replaces the whole list, so send all of it every time.
const schedules = await cf(`/scripts/${SCRIPT}/schedules`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify([{ cron: CRON }]),
});
console.log("deploy: cron", JSON.stringify(schedules));

// 4. Nothing should be able to trigger this over HTTP: it is cron-only.
await cf(`/scripts/${SCRIPT}/subdomain`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ enabled: true, previews_enabled: false }),
});
console.log("deploy: workers.dev route disabled (cron-only worker)");
console.log("deploy: done. Watch it in the dashboard -> Workers -> gazette-drip -> Logs.");
