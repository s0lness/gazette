import { expect, test, describe } from "bun:test";
import {
  LOCK_HOURS,
  DANGER_HOURS,
  MAX_POSTS_NORMAL,
  MAX_POSTS_CATCHUP,
  hoursSince,
  hoursFromRoster,
  urgencyOf,
  orderCandidates,
  postBudget,
  slotAllowed,
  fleetHealth,
  fmtHours,
} from "../tools/drip-priority.mjs";

// The drip picks ONE (or, in a catch-up burst, up to three) pre-written beats per run for a
// fleet of ~18 handles, and the server cuts read access to any handle silent for 36h. These
// cover the pure part of that decision: the urgency ordering and the post budget.

type Cand = { entry: { handle: string; headline?: string }; from: "pantry" | "queue" };
const c = (handle: string, from: "pantry" | "queue" = "queue", headline = ""): Cand => ({
  entry: { handle, headline },
  from,
});
const handles = (list: Cand[]) => list.map((x) => x.entry.handle);
const sources = (list: Cand[]) => list.map((x) => `${x.entry.handle}:${x.from}`);

describe("constants mirror the server rule", () => {
  test("lock is 36h, danger sits below it, budgets are 1 and 3", () => {
    expect(LOCK_HOURS).toBe(36); // functions/_lib/auth.ts LOCK_AFTER_H
    expect(DANGER_HOURS).toBeLessThan(LOCK_HOURS);
    expect(MAX_POSTS_NORMAL).toBe(1);
    expect(MAX_POSTS_CATCHUP).toBe(3);
  });
});

describe("hoursSince / hoursFromRoster", () => {
  const now = Date.parse("2026-08-03T12:00:00Z");

  test("missing or unparseable timestamp = Infinity", () => {
    expect(hoursSince(null, now)).toBe(Infinity);
    expect(hoursSince("", now)).toBe(Infinity);
    expect(hoursSince("not a date", now)).toBe(Infinity);
  });

  test("counts whole hours of silence", () => {
    expect(hoursSince("2026-08-02T12:00:00Z", now)).toBe(24);
    expect(hoursSince("2026-08-03T11:00:00Z", now)).toBe(1);
  });

  test("roster rows fold into handle -> hours, never-posted stays Infinity", () => {
    const map = hoursFromRoster(
      [
        { handle: "alpha", last_posted_at: "2026-08-02T12:00:00Z" },
        { handle: "beta", last_posted_at: null },
        { handle: "gamma" },
        null,
      ],
      now,
    );
    expect(map.get("alpha")).toBe(24);
    expect(map.get("beta")).toBe(Infinity);
    expect(map.get("gamma")).toBe(Infinity);
    expect(map.size).toBe(3);
  });

  test("a handle absent from the map counts as never posted", () => {
    expect(urgencyOf({ alpha: 3 }, "nobody")).toBe(Infinity);
    expect(urgencyOf(new Map([["alpha", 3]]), "alpha")).toBe(3);
  });
});

describe("orderCandidates", () => {
  test("a never-posted handle sorts first", () => {
    const list = [c("alpha"), c("beta"), c("ghost")];
    const out = orderCandidates(list, { alpha: 30, beta: 12 }); // ghost unknown = never
    expect(handles(out)).toEqual(["ghost", "alpha", "beta"]);
  });

  test("40h outranks 10h regardless of file order", () => {
    const list = [c("fresh"), c("stale")];
    const out = orderCandidates(list, { fresh: 10, stale: 40 });
    expect(handles(out)).toEqual(["stale", "fresh"]);
  });

  test("ties keep the original file order", () => {
    const list = [c("a"), c("b"), c("d"), c("e")];
    const out = orderCandidates(list, { a: 20, b: 20, d: 20, e: 20 });
    expect(handles(out)).toEqual(["a", "b", "d", "e"]);
  });

  test("within one handle a pantry beat beats a queue beat", () => {
    const list = [c("alpha", "queue"), c("alpha", "pantry")];
    const out = orderCandidates(list, { alpha: 12 });
    expect(sources(out)).toEqual(["alpha:pantry", "alpha:queue"]);
  });

  test("pantry does NOT jump a starving handle's queue beat", () => {
    // The old bug: pantry-then-queue file order, so @starving waited days.
    const list = [c("fresh", "pantry"), c("starving", "queue")];
    const out = orderCandidates(list, { fresh: 2, starving: 41 });
    expect(sources(out)).toEqual(["starving:queue", "fresh:pantry"]);
  });

  test("an empty clock degrades to plain file order", () => {
    const list = [c("a", "pantry"), c("b"), c("d")];
    expect(handles(orderCandidates(list, new Map()))).toEqual(["a", "b", "d"]);
  });

  test("does not mutate its input", () => {
    const list = [c("fresh"), c("stale")];
    orderCandidates(list, { fresh: 1, stale: 50 });
    expect(handles(list)).toEqual(["fresh", "stale"]);
  });

  test("a beat with no handle sorts last, never first", () => {
    const list = [{ entry: { handle: "" }, from: "queue" as const }, c("alpha")];
    const out = orderCandidates(list, { alpha: 5 });
    expect(handles(out as Cand[])).toEqual(["alpha", ""]);
  });

  test("realistic fleet: the closest to the 36h lock leads", () => {
    const list = [c("gazette", "pantry"), c("yuka"), c("family-budget"), c("vigil")];
    const out = orderCandidates(list, { gazette: 1, yuka: 66, "family-budget": 94, vigil: 1 });
    expect(handles(out)).toEqual(["family-budget", "yuka", "gazette", "vigil"]);
  });
});

describe("postBudget", () => {
  test("everyone healthy -> a normal run of 1", () => {
    const r = postBudget({ a: 2, b: 10, d: 23 }, ["a", "b", "d"]);
    expect(r.budget).toBe(MAX_POSTS_NORMAL);
    expect(r.catchup).toBe(false);
    expect(r.atRisk).toEqual([]);
  });

  test("several handles past DANGER_HOURS -> a burst of 3", () => {
    const r = postBudget({ a: 40, b: 30, d: 26, e: 2 }, ["a", "b", "d", "e"]);
    expect(r.budget).toBe(MAX_POSTS_CATCHUP);
    expect(r.catchup).toBe(true);
    expect(r.atRisk).toEqual(["a", "b", "d"]); // most silent first
  });

  test("the burst is capped by how many handles are actually at risk", () => {
    expect(postBudget({ a: 40, b: 2 }, ["a", "b"]).budget).toBe(1);
    expect(postBudget({ a: 40, b: 37, d: 2 }, ["a", "b", "d"]).budget).toBe(2);
    expect(postBudget({ a: 40, b: 37, d: 30, e: 25 }, ["a", "b", "d", "e"]).budget).toBe(3);
  });

  test("exactly DANGER_HOURS counts as at risk, just under does not", () => {
    expect(postBudget({ a: DANGER_HOURS }, ["a"]).catchup).toBe(true);
    expect(postBudget({ a: DANGER_HOURS - 0.1 }, ["a"]).catchup).toBe(false);
  });

  test("a never-posted eligible handle triggers the catch-up", () => {
    const r = postBudget({ b: 1 }, ["ghost", "b"]);
    expect(r.catchup).toBe(true);
    expect(r.atRisk).toEqual(["ghost"]);
  });

  test("a handle that posted today is excluded (it is not in the eligible set)", () => {
    // @stale is 40h stale but already posted this run's day, so the caller drops it and the
    // run stays normal.
    const hours = { stale: 40, fine: 3 };
    expect(postBudget(hours, ["stale", "fine"]).catchup).toBe(true);
    const r = postBudget(hours, ["fine"]);
    expect(r.catchup).toBe(false);
    expect(r.budget).toBe(1);
    expect(r.atRisk).toEqual([]);
  });

  test("no eligible handle at all -> budget 1, nothing to spend it on", () => {
    const r = postBudget({ a: 40 }, []);
    expect(r.budget).toBe(1);
    expect(r.catchup).toBe(false);
  });
});

describe("slotAllowed: the burst only spends slots on at-risk handles", () => {
  test("the first slot is the ordinary one, open to anyone", () => {
    expect(slotAllowed({ healthy: 1 }, "healthy", 0)).toBe(true);
    expect(slotAllowed({ stale: 40 }, "stale", 0)).toBe(true);
  });

  test("extra slots are refused to a healthy handle and granted to an at-risk one", () => {
    expect(slotAllowed({ healthy: 5 }, "healthy", 1)).toBe(false);
    expect(slotAllowed({ healthy: 5 }, "healthy", 2)).toBe(false);
    expect(slotAllowed({ stale: 30 }, "stale", 1)).toBe(true);
    expect(slotAllowed({ stale: 40 }, "stale", 2)).toBe(true);
    expect(slotAllowed({}, "ghost", 2)).toBe(true); // never posted
  });

  test("a whole burst run only touches at-risk handles after the first post", () => {
    const hours = { a: 45, b: 30, healthy: 3 };
    const order = orderCandidates([c("healthy"), c("a"), c("b")], hours);
    const { budget } = postBudget(hours, ["healthy", "a", "b"]);
    const picked: string[] = [];
    for (const cand of order) {
      if (picked.length >= budget) break;
      const h = cand.entry.handle;
      if (picked.includes(h)) continue; // one beat per handle per run
      if (!slotAllowed(hours, h, picked.length)) continue;
      picked.push(h);
    }
    expect(picked).toEqual(["a", "b"]); // @healthy never gets a burst slot
  });
});

describe("fleetHealth", () => {
  test("splits the fleet into locked / at risk / healthy", () => {
    const h = fleetHealth({ dead: 90, late: 40, warn: 26, ok: 3 }, ["dead", "late", "warn", "ok", "ghost"]);
    expect(h.locked.map((r) => r.handle)).toEqual(["ghost", "dead", "late"]); // ghost = never posted
    expect(h.warn.map((r) => r.handle)).toEqual(["warn"]);
    expect(h.healthy.map((r) => r.handle)).toEqual(["ok"]);
  });

  test("boundaries: exactly 36h is locked, exactly 24h is at risk", () => {
    const h = fleetHealth({ a: LOCK_HOURS, b: DANGER_HOURS, d: DANGER_HOURS - 1 }, ["a", "b", "d"]);
    expect(h.locked.map((r) => r.handle)).toEqual(["a"]);
    expect(h.warn.map((r) => r.handle)).toEqual(["b"]);
    expect(h.healthy.map((r) => r.handle)).toEqual(["d"]);
  });

  test("counts every handle once", () => {
    const h = fleetHealth({ a: 1 }, ["a", "a"]);
    expect(h.healthy).toHaveLength(1);
  });
});

describe("fmtHours", () => {
  test("rounds to whole hours, Infinity reads as never", () => {
    expect(fmtHours(40.6)).toBe("41h");
    expect(fmtHours(0)).toBe("0h");
    expect(fmtHours(Infinity)).toBe("never");
  });
});
