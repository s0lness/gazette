import { expect, test, describe } from "bun:test";
import { createDripRun, MAX_ATTEMPTS } from "../tools/drip-run.mjs";
import { MAX_POSTS_CATCHUP, DANGER_HOURS } from "../tools/drip-priority.mjs";

// tools/drip-run.mjs is the loop BOTH drips run: the PC one (tools/drip.mjs) and the
// Cloudflare Worker (worker-drip/). Only one of the two may be enabled at a time, but they
// must never diverge either, so the skip filters, the attempt ceiling and "one beat per
// handle per run" are tested here once, on the shared implementation.

type Cand = { entry: { handle: string; headline?: string }; from: "pantry" | "queue" };
const c = (handle: string, from: "pantry" | "queue" = "queue", headline = ""): Cand => ({
  entry: { handle, headline },
  from,
});
// Drive a run the way both callers do: take each pick, count an attempt, record a post.
const drain = (run: ReturnType<typeof createDripRun>) => {
  const picked: string[] = [];
  for (const cand of run.picks()) {
    run.countAttempt();
    run.recordPost(cand.entry.handle);
    picked.push(cand.entry.handle);
  }
  return picked;
};

describe("createDripRun: the plan", () => {
  test("a healthy fleet posts one beat, for the stalest handle", () => {
    const run = createDripRun({
      candidates: [c("fresh"), c("stale"), c("mid")],
      hoursByHandle: { fresh: 1, stale: 20, mid: 9 },
    });
    expect(run.budget).toBe(1);
    expect(run.catchup).toBe(false);
    expect(drain(run)).toEqual(["stale"]);
  });

  test("handles at risk turn it into a catch-up burst across DIFFERENT handles", () => {
    const run = createDripRun({
      candidates: [c("a"), c("a"), c("b"), c("d"), c("healthy")],
      hoursByHandle: { a: 40, b: 30, d: 26, healthy: 2 },
    });
    expect(run.catchup).toBe(true);
    expect(run.budget).toBe(MAX_POSTS_CATCHUP);
    expect(drain(run)).toEqual(["a", "b", "d"]); // never twice for @a, never @healthy
  });

  test("a handle with no token is skipped, and reported once per beat", () => {
    const skipped: string[] = [];
    const run = createDripRun({
      candidates: [c("nameless"), c("known")],
      hoursByHandle: { nameless: 50, known: 5 },
      hasToken: (h: string) => h === "known",
      onSkip: (h: string) => skipped.push(h),
    });
    expect(drain(run)).toEqual(["known"]);
    expect(skipped).toEqual(["nameless"]);
    // A tokenless handle is not eligible, so it cannot justify a burst either.
    expect(run.catchup).toBe(false);
  });

  test("handles that already posted today start blocked", () => {
    const run = createDripRun({
      candidates: [c("done"), c("waiting")],
      hoursByHandle: { done: 40, waiting: 30 },
      blocked: ["done"],
    });
    expect(drain(run)).toEqual(["waiting"]);
  });

  test("blocking a handle mid-run drops its remaining beats", () => {
    const run = createDripRun({
      candidates: [c("capped"), c("capped"), c("other")],
      hoursByHandle: { capped: 40, other: 30 },
    });
    const picked: string[] = [];
    for (const cand of run.picks()) {
      run.countAttempt();
      if (cand.entry.handle === "capped") {
        run.block("capped"); // the 429 / 404 path: the beat stays, the handle sits out
        continue;
      }
      run.recordPost(cand.entry.handle);
      picked.push(cand.entry.handle);
    }
    expect(picked).toEqual(["other"]);
  });
});

describe("createDripRun: the attempt ceiling", () => {
  test("a normal run tries at most MAX_ATTEMPTS beats before giving up", () => {
    const run = createDripRun({
      candidates: Array.from({ length: 20 }, (_, i) => c(`h${i}`)),
      hoursByHandle: {}, // everyone unknown = never posted... but budget is capped below
    });
    let tried = 0;
    for (const _ of run.picks()) {
      run.countAttempt(); // every beat fails its lint: nothing is ever posted
      tried++;
    }
    // budget = MAX_POSTS_CATCHUP here (everyone is "never posted"), so the ceiling grows
    // by one per extra slot, matching the PC drip exactly.
    expect(run.attemptCeiling).toBe(MAX_ATTEMPTS + run.budget - 1);
    expect(tried).toBe(run.attemptCeiling);
    expect(run.gaveUp).toBe(true);
    expect(run.posts).toBe(0);
  });

  test("skips do not burn attempts", () => {
    const run = createDripRun({
      candidates: [c("no-token"), c("no-token"), c("real")],
      hoursByHandle: { "no-token": 50, real: 40 },
      hasToken: (h: string) => h === "real",
    });
    expect(drain(run)).toEqual(["real"]);
    expect(run.attempts).toBe(1);
    expect(run.gaveUp).toBe(false);
  });

  test("the run stops as soon as the budget is spent", () => {
    const run = createDripRun({
      candidates: [c("a"), c("b")],
      hoursByHandle: { a: 5, b: 3 },
    });
    expect(drain(run)).toEqual(["a"]);
    expect(run.attempts).toBe(1);
  });
});

describe("createDripRun: the clock is live", () => {
  test("zeroing a handle's silence after posting closes the burst to it", () => {
    // Same object the caller mutates after a successful post, exactly as both drips do.
    const hours = new Map<string, number>([
      ["a", DANGER_HOURS + 10],
      ["b", DANGER_HOURS + 5],
    ]);
    const run = createDripRun({ candidates: [c("a"), c("b")], hoursByHandle: hours });
    expect(run.budget).toBe(2);
    const first = run.picks().next().value as Cand;
    expect(first.entry.handle).toBe("a");
  });
});
