import { expect, test, describe } from "bun:test";
import {
  hasVerbatimRun,
  buildCorpus,
  cleanAnswer,
  askOracleWithRetry,
  VERBATIM_REFUSAL,
  type DMOutcome,
} from "../functions/_lib/dm";

const corpus = `We refactored the payment pipeline and moved every retry into a single
idempotent worker that dedupes on the request id before touching the ledger.
Then we shipped the new onboarding flow and cut signup time roughly in half.`;

describe("hasVerbatimRun", () => {
  test("catches an exact 12+ word quote from the corpus", () => {
    const answer =
      "The agent said they moved every retry into a single idempotent worker that dedupes on the request id.";
    expect(hasVerbatimRun(answer, corpus, 12)).toBe(true);
  });

  test("allows a paraphrase", () => {
    const answer =
      "They reworked how payment retries happen so duplicates get caught before the ledger is updated.";
    expect(hasVerbatimRun(answer, corpus, 12)).toBe(false);
  });

  test("allows a short verbatim snippet under the threshold", () => {
    const answer = "They shipped the new onboarding flow.";
    expect(hasVerbatimRun(answer, corpus, 12)).toBe(false);
  });

  test("ignores punctuation and case when matching", () => {
    const answer =
      "MOVED EVERY RETRY INTO A SINGLE IDEMPOTENT WORKER THAT DEDUPES ON THE REQUEST ID!!!";
    expect(hasVerbatimRun(answer, corpus, 12)).toBe(true);
  });

  test("empty answer is safe", () => {
    expect(hasVerbatimRun("", corpus, 12)).toBe(false);
  });

  // The default threshold is now 25 words (target bulk extraction, not honest short
  // quotes; a tiny corpus makes any faithful short answer overlap a dozen words).
  test("default threshold is 25: a 12-to-24-word verbatim overlap PASSES", () => {
    // This 18-word run is a verbatim slice of the corpus but under 25 words.
    const answer =
      "moved every retry into a single idempotent worker that dedupes on the request id before touching the ledger.";
    expect(hasVerbatimRun(answer, corpus)).toBe(false); // default n = 25
    expect(hasVerbatimRun(answer, corpus, 12)).toBe(true); // still trips at 12
  });

  test("default threshold: a 25+ word verbatim run TRIPS", () => {
    const twentyFive =
      "we refactored the payment pipeline and moved every retry into a single idempotent worker that dedupes on the request id before touching the ledger then we shipped";
    expect(hasVerbatimRun(twentyFive, corpus)).toBe(true);
  });
});

// The retry-before-refuse wrapper: one call; on a verbatim trip, re-ask ONCE with the
// nudge; only then fall back to the refusal. `corpus` here is one long sentence so a
// full echo trips the 25-word default.
describe("askOracleWithRetry", () => {
  const longCorpus = Array.from({ length: 40 }, (_, i) => "alpha" + i).join(" ");
  const ok = (answer: string): DMOutcome => ({ ok: true, answer });

  test("first answer clean -> served as-is, no retry", async () => {
    let calls = 0;
    const out = await askOracleWithRetry(longCorpus, async () => {
      calls++;
      return ok("A short original paraphrase in my own words.");
    });
    expect(out.ok).toBe(true);
    expect(out.answer).toBe("A short original paraphrase in my own words.");
    expect(calls).toBe(1);
  });

  test("first trips, retry clean -> retry answer served (2 calls)", async () => {
    let calls = 0;
    const out = await askOracleWithRetry(longCorpus, async (extra) => {
      calls++;
      if (calls === 1) return ok(longCorpus); // verbatim dump -> trips
      expect(extra).toBeTruthy(); // the retry gets the nudge
      return ok("A clean rephrase this time.");
    });
    expect(out.answer).toBe("A clean rephrase this time.");
    expect(calls).toBe(2);
  });

  test("first trips, retry still verbatim -> refusal", async () => {
    let calls = 0;
    const out = await askOracleWithRetry(longCorpus, async () => {
      calls++;
      return ok(longCorpus); // both calls dump the corpus
    });
    expect(out.answer).toBe(VERBATIM_REFUSAL);
    expect(calls).toBe(2);
  });

  test("first call unavailable -> propagated (no retry, caller 503s)", async () => {
    let calls = 0;
    const out = await askOracleWithRetry(longCorpus, async () => {
      calls++;
      return { ok: false, unavailable: true };
    });
    expect(out.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("first trips, retry unavailable -> keep the first cleaned answer (no 503)", async () => {
    let calls = 0;
    const out = await askOracleWithRetry(longCorpus, async () => {
      calls++;
      if (calls === 1) return ok(longCorpus);
      return { ok: false, unavailable: true };
    });
    expect(out.ok).toBe(true);
    expect(out.answer).toBe(longCorpus); // the first (cleaned) answer, not a refusal
    expect(calls).toBe(2);
  });
});

describe("buildCorpus", () => {
  test("concatenates dailies with date headers, most recent first", () => {
    const out = buildCorpus([
      { date: "2026-07-29", body_md: "today" },
      { date: "2026-07-28", body_md: "yesterday" },
    ]);
    expect(out).toContain("2026-07-29");
    expect(out).toContain("today");
    expect(out.indexOf("2026-07-29")).toBeLessThan(out.indexOf("2026-07-28"));
  });

  test("truncates to the max length", () => {
    const big = { date: "2026-07-29", body_md: "x".repeat(1000) };
    const out = buildCorpus([big], 200);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("cleanAnswer", () => {
  test("replaces a spaced em dash with a comma", () => {
    expect(cleanAnswer("I shipped it — then I tested it.")).toBe("I shipped it, then I tested it.");
  });

  test("replaces an en dash too", () => {
    expect(cleanAnswer("Days 1–3 were slow.")).toBe("Days 1, 3 were slow.");
  });

  test("handles a tight (unspaced) em dash", () => {
    expect(cleanAnswer("fast—slow")).toBe("fast, slow");
  });

  test("collapses a run of dashes", () => {
    expect(cleanAnswer("a —— b")).toBe("a, b");
  });

  test("no em/en dash survives, ever", () => {
    const out = cleanAnswer("one — two – three —— four");
    expect(out).not.toMatch(/[—–]/);
  });

  test("does not double up commas or spaces", () => {
    expect(cleanAnswer("I did X, — and Y.")).toBe("I did X, and Y.");
  });

  test("leaves clean prose untouched (trimmed)", () => {
    expect(cleanAnswer("  I have not written about that here.  ")).toBe(
      "I have not written about that here.",
    );
  });

  test("handles null/empty safely", () => {
    expect(cleanAnswer("")).toBe("");
    // @ts-expect-error runtime guard
    expect(cleanAnswer(null)).toBe("");
  });
});
