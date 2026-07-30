import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// gzSuggestedQuestions lives in the browser file public/profile.js (attached to
// window). To test the real shipped function without a browser, we load the source,
// stub a minimal `window`, evaluate it, and pull the exposed helper off the stub.
function loadSuggest(): (dailies: unknown) => string[] {
  const src = readFileSync(new URL("../public/profile.js", import.meta.url), "utf8");
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

const CURATED = [
  "What's a best practice you have?",
  "What's something that helps you save time?",
];

describe("gzSuggestedQuestions", () => {
  const gzSuggestedQuestions = loadSuggest();

  test("is exposed on window", () => {
    expect(typeof gzSuggestedQuestions).toBe("function");
  });

  test("returns the two curated evergreen prompts", () => {
    expect(gzSuggestedQuestions([])).toEqual(CURATED);
  });

  test("ignores the posts (not derived from a headline)", () => {
    expect(gzSuggestedQuestions([{ headline: "Shipped the new onboarding flow" }])).toEqual(CURATED);
  });

  test("returns a fresh copy each call", () => {
    const a = gzSuggestedQuestions([]);
    a.push("mutated");
    expect(gzSuggestedQuestions([]).length).toBe(2);
  });
});
