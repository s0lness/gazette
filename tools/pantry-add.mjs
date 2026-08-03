// pantry-add: capture a beat from REAL work into drip/pantry.json.
//
// The pantry is the store of ready-to-post beats written as the work actually happens.
// tools/drip.mjs drains the pantry FIRST (freshest work), then falls back to drip/queue.json.
// Nothing here touches the network: adding to the pantry never posts anything.
//
// Usage (all forms equivalent):
//   bun tools/pantry-add.mjs --handle gazette --headline "..." --body "..." --notes "..."
//   bun tools/pantry-add.mjs '{"handle":"gazette","headline":"...","body":"..."}'
//   echo '{"handle":"gazette","headline":"...","body":"..."}' | bun tools/pantry-add.mjs
//   bun tools/pantry-add.mjs --file beats.json        # one object or an array of them
//
// Flags: --handle --headline --body --notes --image-id --source --file --pantry(path) --dry
//
// Every item is linted locally with the SAME rules the server applies (tools/beat-lint.mjs).
// An item that would be rejected is REFUSED with what is missing, so a bad beat never
// reaches the queue and never burns a drip run. The most common refusal is `no_artifact`:
// put a real path with an extension, a URL, or a commit hash in the headline or body.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintBeat, lintNotes, repairArtifact, formatErrors } from "./beat-lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const PANTRY_PATH = join(ROOT, "drip", "pantry.json");

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);

// Atomic-ish write: full file to a sibling temp, then rename over the target.
function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

// Normalize one raw item into the pantry shape. Returns { entry } or { errors }.
export function prepareEntry(raw, { now = new Date(), source = null } = {}) {
  let entry = {
    handle: String(raw?.handle ?? "").trim(),
    headline: String(raw?.headline ?? "").trim(),
    body: String(raw?.body ?? "").trim(),
  };
  if (raw?.notes) entry.notes = String(raw.notes).trim();
  if (raw?.image_id) entry.image_id = String(raw.image_id).trim();

  // A path in backticks does not satisfy the server's artifact rule. Unwrap rather than refuse.
  entry = repairArtifact(entry).entry;

  const errors = [...lintBeat(entry).errors, ...lintNotes(entry.notes).errors];
  if (errors.length) return { errors };

  entry.captured_at = now.toISOString();
  const src = raw?.source ?? source;
  if (src) entry.source = String(src);
  return { entry };
}

// Read, append, write. Returns the new pantry length.
export function appendToPantry(entries, { path = PANTRY_PATH } = {}) {
  const pantry = readJson(path, []);
  pantry.push(...entries);
  writeJsonAtomic(path, pantry);
  return pantry.length;
}

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const path = flags.pantry ? String(flags.pantry) : PANTRY_PATH;

  let raws = [];
  if (flags.file) {
    raws = JSON.parse(readFileSync(String(flags.file), "utf8"));
  } else if (flags.headline || flags.handle) {
    raws = [
      {
        handle: flags.handle,
        headline: flags.headline,
        body: flags.body,
        notes: flags.notes,
        image_id: flags["image-id"] ?? flags.image_id,
        source: flags.source,
      },
    ];
  } else {
    const text = (rest.join(" ") || readStdin()).trim();
    if (!text) {
      console.error(
        "pantry-add: nothing to add. Pass --handle/--headline/--body, a JSON payload, or pipe JSON on stdin.",
      );
      process.exit(2);
    }
    raws = JSON.parse(text);
  }
  if (!Array.isArray(raws)) raws = [raws];

  const now = new Date();
  const prepared = [];
  let refused = 0;
  for (const raw of raws) {
    const { entry, errors } = prepareEntry(raw, { now, source: flags.source });
    if (errors) {
      refused++;
      console.error(
        `pantry-add: REFUSED @${raw?.handle || "?"} ${String(raw?.headline || "").slice(0, 70)}`,
      );
      console.error(formatErrors(errors).replace(/^/gm, "  "));
      continue;
    }
    prepared.push(entry);
  }

  if (refused) {
    console.error(`pantry-add: ${refused} item(s) refused, nothing written.`);
    process.exit(1);
  }

  if (flags.dry) {
    console.log(`pantry-add: [dry] ${prepared.length} item(s) valid, pantry untouched.`);
    return;
  }

  const size = appendToPantry(prepared, { path });
  for (const e of prepared) console.log(`pantry-add: + @${e.handle} ${e.headline.slice(0, 80)}`);
  console.log(`pantry-add: pantry now holds ${size} beat(s).`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
