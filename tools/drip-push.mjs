// drip-push: push the beats waiting on this PC into D1, where the Cloudflare Worker can
// drain them. The PC half of the move off the Windows scheduled task.
//
//   drip/pantry.json + drip/queue.json   ->   D1 table drip_queue   ->   worker-drip/
//
// Run it by hand (or from a hook) whenever new beats have been captured:
//
//   bun tools/drip-push.mjs --dry     # read-only: what WOULD be inserted
//   bun tools/drip-push.mjs           # insert what is missing
//
// Properties:
//   IDEMPOTENT   every beat carries a dedupe_key (sha-256 of handle + "\n" + headline, see
//                tools/drip-dedupe.mjs). The push reads the keys already in the table and
//                inserts ONLY the ones it has never seen, in ANY state. A beat that was
//                already posted or parked is never re-inserted and never resurrected: this
//                tool only ever INSERTs, it never UPDATEs a known row. INSERT OR IGNORE on
//                the UNIQUE key is the second line of defence if two pushes race.
//   ORDER-SAFE   `origin` keeps pantry ahead of queue, and `position` keeps the file order
//                the selection breaks ties on (pantry rows 0..n, queue rows 1000000+i), so
//                appending to a file later never renumbers what is already in D1.
//   BATCHED      rows go up in batches of ROWS_PER_BATCH as one multi-VALUES INSERT, so a
//                few hundred beats cost a handful of requests and stay under SQLite's bound
//                parameter ceiling.
//
// Credentials: CLOUDFLARE_API_TOKEN, read from the project .secrets.env first, then
// ~/projects/.secrets.env, then the environment (a file is re-read every run; an env var
// inherited by a long-lived process can be stale). The token is NEVER printed or uploaded.
//
// The pure parts (row building, the insert plan) are exported and covered by
// tests/drip-push.test.ts; running the file is what talks to the network.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dedupeKey } from "./drip-dedupe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

// The live gazette D1 (same id as wrangler.toml's [[d1_databases]] for the Pages project).
export const DATABASE_ID = "6abd6020-3085-4782-8234-d6f2156f23a9";

// Queue rows sit after every pantry row in the tie-break order, exactly as the PC drip's
// flat "pantry first, then queue" candidate list did. A fixed offset (rather than
// pantry.length + i) keeps a row's position stable when the pantry grows later.
export const QUEUE_POSITION_BASE = 1000000;

// One INSERT carries ROWS_PER_BATCH * COLUMNS.length bound parameters. D1 caps a query at
// 100 bound parameters, NOT SQLite's 999. 60 rows (720 binds) is what made the first real
// push fail with "too many SQL variables", so 8 x 12 = 96 stays under the real ceiling.
export const COLUMNS = [
  "handle",
  "headline",
  "body",
  "notes",
  "image_id",
  "source",
  "captured_at",
  "origin",
  "dedupe_key",
  "position",
  "state",
  "created_at",
];
export const ROWS_PER_BATCH = 8;

const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

// Turn the two files into insertable rows, in the order the drip reads them.
// A beat with no handle or no headline can never be posted, so it is dropped here rather
// than parked later. The same beat present twice (same handle + headline) yields ONE row.
export async function buildRows({ pantry = [], queue = [], now = new Date() } = {}) {
  const rows = [];
  const seen = new Set();
  const createdAt = now.toISOString();
  const sources = [
    { list: pantry, origin: "pantry", base: 0 },
    { list: queue, origin: "queue", base: QUEUE_POSITION_BASE },
  ];
  for (const { list, origin, base } of sources) {
    for (let i = 0; i < list.length; i++) {
      const entry = list[i] || {};
      const handle = String(entry.handle ?? "").trim();
      const headline = String(entry.headline ?? "").trim();
      if (!handle || !headline) continue;
      const key = await dedupeKey(handle, headline);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        handle,
        headline,
        body: str(entry.body),
        notes: str(entry.notes),
        image_id: str(entry.image_id),
        source: str(entry.source),
        captured_at: str(entry.captured_at),
        origin,
        dedupe_key: key,
        position: base + i,
        state: "queued",
        created_at: createdAt,
      });
    }
  }
  return rows;
}

// The idempotency computation: which of these rows D1 has never seen. `existingKeys` is
// every dedupe_key already in the table, whatever its state.
export function partitionRows(rows, existingKeys) {
  const have = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const fresh = [];
  const present = [];
  for (const row of rows || []) (have.has(row.dedupe_key) ? present : fresh).push(row);
  return { fresh, present };
}

// The batched INSERTs for a set of fresh rows: [{ sql, params }]. OR IGNORE so a row that
// appeared between the read and the write is skipped instead of failing the whole batch.
export function insertStatements(rows, perBatch = ROWS_PER_BATCH) {
  const out = [];
  const cols = COLUMNS.join(", ");
  const tuple = `(${COLUMNS.map(() => "?").join(", ")})`;
  for (let i = 0; i < (rows || []).length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    out.push({
      sql: `INSERT OR IGNORE INTO drip_queue (${cols}) VALUES ${batch.map(() => tuple).join(", ")}`,
      params: batch.flatMap((r) => COLUMNS.map((c) => r[c])),
    });
  }
  return out;
}

// ---- CLI ------------------------------------------------------------------

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);

// Project .secrets.env > ~/projects/.secrets.env > environment. Never logged.
function secret(name) {
  for (const p of [join(ROOT, ".secrets.env"), join(homedir(), "projects", ".secrets.env")]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    if (m) return m[1].trim();
  }
  if (process.env[name]) return process.env[name];
  throw new Error(`${name} not found in .secrets.env (project or global) or the environment`);
}

async function main() {
  const dry = process.argv.includes("--dry");
  const pantry = readJson(join(ROOT, "drip", "pantry.json"), []);
  const queue = readJson(join(ROOT, "drip", "queue.json"), []);
  const rows = await buildRows({ pantry, queue });
  console.log(
    `drip-push: ${rows.length} postable beat(s) in the files (${pantry.length} pantry, ${queue.length} queue)`,
  );

  const token = secret("CLOUDFLARE_API_TOKEN");
  const account = secret("CLOUDFLARE_ACCOUNT_ID");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DATABASE_ID}/query`;
  // Errors are printed with the credential stripped out of anything Cloudflare echoes back.
  const scrub = (text) => String(text).split(token).join("<redacted>");

  const d1 = async (sql, params = []) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.success) throw new Error(scrub(JSON.stringify(body.errors ?? body)));
    return body.result ?? [];
  };

  // What is already there? A failure here (most often: the migration has not been applied
  // yet) degrades to "assume empty" so --dry still shows the plan.
  let existing = new Set();
  let known = true;
  try {
    const [rs] = await d1("SELECT dedupe_key FROM drip_queue");
    existing = new Set((rs?.results ?? []).map((r) => r.dedupe_key));
  } catch (err) {
    known = false;
    console.log(`drip-push: could not read drip_queue (${err.message})`);
    console.log("drip-push: has migrations/0027_drip_queue.sql been applied to the live D1?");
  }

  const { fresh, present } = partitionRows(rows, existing);
  console.log(
    `drip-push: ${present.length} already in D1, ${fresh.length} to insert` +
      (known ? "" : " (table state unknown, assuming empty)"),
  );

  const statements = insertStatements(fresh);
  if (dry) {
    for (const row of fresh.slice(0, 10)) {
      console.log(`drip-push: [dry] + @${row.handle} [${row.origin}] ${row.headline.slice(0, 70)}`);
    }
    if (fresh.length > 10) console.log(`drip-push: [dry] ... and ${fresh.length - 10} more`);
    console.log(`drip-push: [dry] ${statements.length} INSERT batch(es), nothing written`);
    return;
  }

  let inserted = 0;
  for (const [i, stmt] of statements.entries()) {
    const [rs] = await d1(stmt.sql, stmt.params);
    inserted += rs?.meta?.changes ?? 0;
    console.log(`drip-push: batch ${i + 1}/${statements.length} done`);
  }

  const [tally] = await d1("SELECT state, COUNT(*) AS n FROM drip_queue GROUP BY state");
  const byState = Object.fromEntries((tally?.results ?? []).map((r) => [r.state, r.n]));
  console.log(
    `drip-push: inserted ${inserted}, already present ${present.length}. ` +
      `drip_queue now: ${byState.queued ?? 0} queued, ${byState.posted ?? 0} posted, ${byState.parked ?? 0} parked.`,
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`drip-push: ${err.message}`);
    process.exit(1);
  });
}
