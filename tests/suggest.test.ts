import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// gzSuggestedQuestions lives in the browser file public/profile.js (attached to
// window). To test the pure derivation without a browser, we load the source,
// stub a minimal `window`, evaluate it, and pull the exposed helper off the stub.
// This tests the real shipped function, no duplicated logic.
function loadSuggest(): (dailies: unknown) => string[] {
  const src = readFileSync(new URL("../public/profile.js", import.meta.url), "utf8");
  // Minimal stubs so the IIFE runs to the point where it exposes the helper:
  // a #root element, a token so it does not raise the wall, and a no-op poll.
  const rootEl: any = { getAttribute: () => "someagent", querySelectorAll: () => [] };
  const win: any = {
    gzToken: () => "tok",
    gzLivePoll: () => {},
    addEventListener: () => {},
    gzReduceMotion: () => true,
    __PROFILE__: null,
  };
  win.location = { hash: "" };
  const doc: any = {
    getElementById: (id: string) => (id === "root" ? rootEl : null),
    addEventListener: () => {},
  };
  const fn = new Function("window", "document", "location", src);
  fn(win, doc, win.location);
  return win.gzSuggestedQuestions;
}

describe("gzSuggestedQuestions", () => {
  const gzSuggestedQuestions = loadSuggest();

  test("is exposed on window", () => {
    expect(typeof gzSuggestedQuestions).toBe("function");
  });

  test("falls back to two generic prompts with no posts", () => {
    const q = gzSuggestedQuestions([]);
    expect(q.length).toBe(2);
    expect(q).toContain("What was the hardest part?");
  });

  test("derives a topic-specific question from a clean short headline", () => {
    const q = gzSuggestedQuestions([{ headline: "Shipped the new onboarding flow" }]);
    expect(q[0]).toContain("How did you pull off");
    expect(q[0]).toContain("shipped the new onboarding flow");
  });

  test("takes only the first clause of a long headline", () => {
    const q = gzSuggestedQuestions([
      { headline: "Cut signup time in half, then rewrote the retry worker to be idempotent" },
    ]);
    // First clause "Cut signup time in half" is 5 words: specialized.
    expect(q[0].toLowerCase()).toContain("cut signup time in half");
  });

  test("falls back to generic when the leading clause is a run-on", () => {
    const long =
      "We refactored the entire payment pipeline and moved every retry into one idempotent worker";
    const q = gzSuggestedQuestions([{ headline: long }]);
    expect(q).toEqual(["What was the hardest part?", "How did you approach it?"]);
  });

  test("falls back to generic when the phrase carries odd symbols", () => {
    const q = gzSuggestedQuestions([{ headline: "Fixed the $$$ / @auth bug" }]);
    expect(q).toEqual(["What was the hardest part?", "How did you approach it?"]);
  });
});
