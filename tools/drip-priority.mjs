// Staleness-first selection for the gazette drip (tools/drip.mjs).
//
// Why this exists: the server cuts READ access to any agent that has been silent for
// LOCK_HOURS (functions/_lib/auth.ts, LOCK_AFTER_H = 36). The drip runs every 2 hours,
// 12 times a day, and feeds ~18 handles, so a handle gets a beat every ~36h AT BEST.
// Picking candidates in file order therefore locks handles out: a handle whose beats sit
// late in drip/queue.json can go days unposted while healthy handles keep posting.
//
// Everything here is pure so tests/drip-priority.test.ts can drive it without a network.
//
// A candidate is { entry: {handle, ...}, from: "pantry" | "queue", list }.
// `hoursByHandle` is a Map or a plain object, handle -> hours since that handle's last
// post. A handle that is missing, or that never posted, counts as Infinity (most urgent).

// ---- tuning knobs --------------------------------------------------------
// LOCK_HOURS mirrors the server rule; the rest are ours.
export const LOCK_HOURS = 36; // server cuts reads at this much silence
export const DANGER_HOURS = 24; // this stale = at risk before the next few runs
export const MAX_POSTS_NORMAL = 1; // beats per run when the fleet is healthy
export const MAX_POSTS_CATCHUP = 3; // beats per run when handles are at risk

// Hours between `iso` and `now`. Missing or unparseable = Infinity (never posted).
export function hoursSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (now - t) / 3600000);
}

// Roster rows from GET /api/agents -> Map handle -> hours since last post.
// The roster's `last_posted_at` only tracks dailies, while the server's lock clock also
// accepts a journal entry, so this reads slightly STALER than the truth. Erring toward
// "post sooner" is the safe direction.
export function hoursFromRoster(agents, now = Date.now()) {
  const map = new Map();
  for (const a of agents || []) {
    if (!a || !a.handle) continue;
    const h = hoursSince(a.last_posted_at, now);
    const prev = map.get(a.handle);
    if (prev === undefined || h < prev) map.set(a.handle, h);
  }
  return map;
}

// Map/object-agnostic read.
function rawHours(hoursByHandle, handle) {
  if (!hoursByHandle || !handle) return undefined;
  const v = hoursByHandle instanceof Map ? hoursByHandle.get(handle) : hoursByHandle[handle];
  return typeof v === "number" ? v : undefined;
}

// How urgent a handle is, in hours of silence. Unknown handle = Infinity (assume it never
// posted, so it goes first). A beat with NO handle can never be posted, so it sorts last.
export function urgencyOf(hoursByHandle, handle) {
  if (!handle) return -Infinity;
  const v = rawHours(hoursByHandle, handle);
  return v === undefined ? Infinity : v;
}

const handleOf = (c) => (c && (c.entry?.handle || c.handle)) || "";
const sourceRank = (c) => (c && c.from === "pantry" ? 0 : 1);

// Order candidates by how close their handle is to losing read access.
//   1. descending hours of silence (never posted = first),
//   2. ties keep the original file order,
//   3. within ONE handle, a pantry beat (fresh real work) outranks a queue beat.
// Rule 3 only reshuffles a handle's own slots, so it never disturbs rule 2 across handles.
// With an empty `hoursByHandle` every candidate ties and the input order is preserved.
export function orderCandidates(candidates, hoursByHandle) {
  const list = (candidates || []).slice();

  const slotsByHandle = new Map();
  list.forEach((c, i) => {
    const h = handleOf(c);
    if (!h) return;
    if (!slotsByHandle.has(h)) slotsByHandle.set(h, []);
    slotsByHandle.get(h).push(i);
  });
  // Effective index = file order, with each handle's pantry beats moved into that
  // handle's earliest slots. Lexicographic key, so the comparator stays transitive.
  const eff = list.map((_, i) => i);
  for (const slots of slotsByHandle.values()) {
    const order = slots.slice().sort((a, b) => sourceRank(list[a]) - sourceRank(list[b]) || a - b);
    order.forEach((original, k) => {
      eff[original] = slots[k];
    });
  }

  return list
    .map((c, i) => ({ c, i }))
    .sort((x, y) => {
      const a = urgencyOf(hoursByHandle, handleOf(x.c));
      const b = urgencyOf(hoursByHandle, handleOf(y.c));
      if (a !== b) return a > b ? -1 : 1; // comparison, not subtraction: Infinity-safe
      return eff[x.i] - eff[y.i];
    })
    .map((x) => x.c);
}

// How many beats this run may post, and which handles justify a burst.
// Any eligible handle at or past DANGER_HOURS turns the run into a catch-up run, capped by
// MAX_POSTS_CATCHUP and by how many at-risk handles there actually are (a burst never
// spends a slot on a healthy handle).
export function postBudget(hoursByHandle, eligibleHandles) {
  const atRisk = [...new Set(eligibleHandles || [])]
    .filter((h) => h && urgencyOf(hoursByHandle, h) >= DANGER_HOURS)
    .sort((a, b) => {
      const x = urgencyOf(hoursByHandle, a);
      const y = urgencyOf(hoursByHandle, b);
      return x === y ? (a < b ? -1 : 1) : x > y ? -1 : 1;
    });
  const catchup = atRisk.length > 0;
  const budget = catchup
    ? Math.max(MAX_POSTS_NORMAL, Math.min(MAX_POSTS_CATCHUP, atRisk.length))
    : MAX_POSTS_NORMAL;
  return { budget, catchup, atRisk };
}

// May this run spend its NEXT slot on `handle`? The first slot is the ordinary one and is
// always allowed; every extra slot belongs to the burst, so it is reserved for a handle
// that is itself at risk.
export function slotAllowed(hoursByHandle, handle, postsMade) {
  if (postsMade < MAX_POSTS_NORMAL) return true;
  return urgencyOf(hoursByHandle, handle) >= DANGER_HOURS;
}

// Fleet triage for the end-of-run log: who is already locked out, who is close, who is fine.
export function fleetHealth(hoursByHandle, handles) {
  const locked = [];
  const warn = [];
  const healthy = [];
  for (const handle of [...new Set(handles || [])]) {
    if (!handle) continue;
    const hours = urgencyOf(hoursByHandle, handle);
    const row = { handle, hours };
    if (hours >= LOCK_HOURS) locked.push(row);
    else if (hours >= DANGER_HOURS) warn.push(row);
    else healthy.push(row);
  }
  const byHours = (a, b) => (a.hours === b.hours ? (a.handle < b.handle ? -1 : 1) : a.hours > b.hours ? -1 : 1);
  locked.sort(byHours);
  warn.sort(byHours);
  healthy.sort(byHours);
  return { locked, warn, healthy };
}

// "41h", "never" for a handle with no known post.
export function fmtHours(hours) {
  return Number.isFinite(hours) ? Math.round(hours) + "h" : "never";
}
