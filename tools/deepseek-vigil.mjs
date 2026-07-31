// Alert Sylve's Telegram Saved Messages when the gazette oracle's DeepSeek
// account is unhealthy: low balance or API failure. Runs safely alongside the
// scheduled digest task; also safe to run by hand. Exits 0 always.
//
// Balance endpoint doc: https://api-docs.deepseek.com/api/get-user-balance
//   GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <key>
//   Response: { is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(TOOLS, ".deepseek-vigil-state.json");
const NODE = "C:\\Users\\sylve\\tools\\node\\node.exe";
const ANTENNE = "C:\\Users\\sylve\\projects\\antenne";

const LOW_BALANCE_USD = 0.50;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h

// --- parse .secrets.env (KEY=value lines, defensive) ---
function readSecrets(envPath) {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const secrets = readSecrets(join(ROOT, ".secrets.env"));
const DEEPSEEK_API_KEY = secrets["DEEPSEEK_API_KEY"] || "";
if (!DEEPSEEK_API_KEY) {
  console.log("vigil: DEEPSEEK_API_KEY not found in .secrets.env, skipping");
  process.exit(0);
}

// --- anti-spam state ---
function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function shouldAlert(state, kind) {
  const entry = state[kind];
  if (!entry) return true;
  return Date.now() - new Date(entry.sentAt).getTime() > ALERT_COOLDOWN_MS;
}

function recordAlert(state, kind) {
  state[kind] = { sentAt: new Date().toISOString() };
}

function clearAlert(state, kind) {
  delete state[kind];
}

// --- send via antenne send-self ---
function sendTelegram(text) {
  const result = spawnSync(
    NODE,
    ["node_modules/tsx/dist/cli.mjs", "src/send-self.ts", "--text", text],
    { cwd: ANTENNE, encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0) {
    console.log("vigil: telegram send failed");
    console.log((result.stderr || result.stdout || "").slice(-400));
    return false;
  }
  return true;
}

// --- fetch DeepSeek balance ---
let balanceData = null;
let fetchError = null;
let httpStatus = null;

try {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: {
      Authorization: "Bearer " + DEEPSEEK_API_KEY,
      Accept: "application/json",
    },
  });
  httpStatus = res.status;
  if (!res.ok) {
    fetchError = "HTTP " + res.status;
  } else {
    const body = await res.json();
    if (
      typeof body.is_available !== "boolean" ||
      !Array.isArray(body.balance_infos)
    ) {
      fetchError = "unexpected response shape";
    } else {
      balanceData = body;
    }
  }
} catch (err) {
  fetchError = String(err.message || err);
}

const state = loadState();

// --- evaluate and alert ---
if (fetchError) {
  const kind = "api_failure";
  const msg = "gazette oracle: DeepSeek API check failed (" + fetchError + ")";
  if (shouldAlert(state, kind)) {
    sendTelegram(msg);
    recordAlert(state, kind);
    saveState(state);
  }
  console.log("vigil: " + msg);
  process.exit(0);
}

// API reachable: clear any prior api_failure state silently
clearAlert(state, "api_failure");

const { is_available, balance_infos } = balanceData;

// Find the USD entry; fall back to summing all entries if no USD entry exists
const usdEntry = balance_infos.find((b) => b.currency === "USD");
const balanceUSD = usdEntry
  ? parseFloat(usdEntry.total_balance)
  : balance_infos.reduce((sum, b) => sum + parseFloat(b.total_balance || "0"), 0);
const balanceStr = "$" + balanceUSD.toFixed(2);

if (!is_available) {
  const kind = "unavailable";
  const msg =
    "gazette oracle: DeepSeek account unavailable (is_available=false). Top up at platform.deepseek.com";
  if (shouldAlert(state, kind)) {
    sendTelegram(msg);
    recordAlert(state, kind);
  } else {
    clearAlert(state, "low_balance");
  }
  saveState(state);
  console.log("vigil: " + msg);
  process.exit(0);
}

clearAlert(state, "unavailable");

if (balanceUSD < LOW_BALANCE_USD) {
  const kind = "low_balance";
  const msg =
    "gazette oracle: DeepSeek balance low: " +
    balanceStr +
    " left. Top up at platform.deepseek.com";
  if (shouldAlert(state, kind)) {
    sendTelegram(msg);
    recordAlert(state, kind);
  }
  saveState(state);
  console.log("vigil: " + msg);
  process.exit(0);
}

// All clear: recover low_balance state silently
clearAlert(state, "low_balance");
saveState(state);
console.log("vigil: ok, " + balanceStr + " left");
