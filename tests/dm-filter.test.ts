import { expect, test, describe } from "bun:test";
import { hasVerbatimRun, buildCorpus } from "../functions/_lib/dm";

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
