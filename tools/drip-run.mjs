// The ONE implementation of "which beat does this run try next", shared by both drips:
//
//   tools/drip.mjs      the PC drip (json files + the public API), kept for manual runs
//   worker-drip/        the Cloudflare Worker on a 2-hourly cron (D1 + the public API)
//
// Only one of the two may be ENABLED at a time (see worker-drip/README.md): they would
// double-post. But they must never DIVERGE either, hence this module. The ordering, the
// budget and the burst rules live in tools/drip-priority.mjs; this adds the loop around them:
// the skip filters, the attempt ceiling, and "one beat per handle per run".
//
// Everything here is pure (no fs, no fetch, no D1), so tests/drip-run.test.ts drives it
// directly and so a Worker bundle can import it.
//
// A candidate is { entry: {handle, headline, body, ...}, from: "pantry" | "queue", ... }.
// Callers may hang whatever they need off it (the PC drip carries the source `list`, the
// Worker carries the D1 `row`); nothing here reads past `entry.handle` and `from`.
import { MAX_POSTS_NORMAL, orderCandidates, postBudget, slotAllowed } from "./drip-priority.mjs";

// How many beats a single run may TRY before giving up, for its first post. A run with a
// bigger budget gets one extra attempt per extra slot (see attemptCeiling below), so a
// catch-up run keeps the same tolerance for parked beats per post it is trying to make.
export const MAX_ATTEMPTS = 5;

const handleOf = (c) => (c && (c.entry?.handle || c.handle)) || "";

// Build the run for this tick.
//   candidates    the flat pantry-then-queue list
//   hoursByHandle Map|object handle -> hours of silence (missing = never posted = urgent).
//                 Held by REFERENCE: a caller that zeroes a handle's clock after posting
//                 changes what the remaining burst slots are allowed to do, as intended.
//   hasToken      handle -> boolean. A beat we cannot post for is not eligible.
//   blocked       handles unavailable for the whole run (already posted today, or refused
//                 at the handle level: 429 daily cap, 404 unknown token).
//   onSkip        (handle, reason) for the caller's log; reason is "no_token" today.
//
// Returns the plan (ordered / eligible / budget / catchup / atRisk / attemptCeiling) plus a
// `picks()` generator and the three recorders the caller drives. The generator re-reads the
// live state on every step, so blocking a handle or recording a post mid-loop takes effect
// immediately, exactly as the original inline loop did.
export function createDripRun({
  candidates,
  hoursByHandle,
  hasToken = () => true,
  blocked = [],
  onSkip = () => {},
} = {}) {
  const blockedSet = new Set(blocked || []);
  const ordered = orderCandidates(candidates || [], hoursByHandle);
  const eligible = [
    ...new Set(ordered.map(handleOf).filter((h) => h && hasToken(h) && !blockedSet.has(h))),
  ];
  const { budget, catchup, atRisk } = postBudget(hoursByHandle, eligible);
  const attemptCeiling = MAX_ATTEMPTS + budget - 1;
  const state = { attempts: 0, posts: 0, gaveUp: false };

  return {
    ordered,
    eligible,
    budget,
    catchup,
    atRisk,
    attemptCeiling,
    get attempts() {
      return state.attempts;
    },
    get posts() {
      return state.posts;
    },
    get gaveUp() {
      return state.gaveUp;
    },
    isBlocked: (handle) => blockedSet.has(handle),
    // That handle sits the REST of this run out. The beat itself is untouched.
    block(handle) {
      if (handle) blockedSet.add(handle);
    },
    // One try spent (a local-lint park, or an actual POST). Skips do not count.
    countAttempt() {
      return ++state.attempts;
    },
    // A beat went out for `handle`: spends a slot and blocks the handle (one beat per
    // handle per run, so a burst always spreads across DIFFERENT handles).
    recordPost(handle) {
      state.posts++;
      if (handle) blockedSet.add(handle);
    },
    *picks() {
      for (const cand of ordered) {
        if (state.posts >= budget) return;
        if (state.attempts >= attemptCeiling) {
          state.gaveUp = true;
          return;
        }
        const handle = handleOf(cand);
        if (!handle || blockedSet.has(handle)) continue;
        if (!hasToken(handle)) {
          onSkip(handle, "no_token");
          continue;
        }
        // Extra slots belong to the burst: only a handle that is itself at risk may spend
        // one. The first slot (MAX_POSTS_NORMAL) is the ordinary one, open to anyone.
        if (!slotAllowed(hoursByHandle, handle, state.posts)) continue;
        yield cand;
      }
    },
  };
}

export { MAX_POSTS_NORMAL };
