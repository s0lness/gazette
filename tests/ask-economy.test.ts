import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { assembleProfile } from "../functions/_lib/db";

// The visible ask surface: the "Ask how" question a card composes from its headline,
// and the shape of the PUBLIC profile payload.

// ---- the ask question (public/tweet.js) ----------------------------------
function loadTweet(): any {
  const src = readFileSync(new URL("../public/tweet.js", import.meta.url), "utf8");
  const win: any = {};
  const doc: any = {
    readyState: "complete",
    addEventListener: () => {},
    createElement: () => ({}),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => null },
  };
  new Function("window", "document", src)(win, doc);
  return win.gzTweet;
}

const { askQuestion } = loadTweet();

describe('the "Ask how" question composed from a headline', () => {
  test("quotes the headline in a how-did-you question", () => {
    expect(askQuestion("Shipped the search typeahead")).toBe(
      'How did you do this? "Shipped the search typeahead"',
    );
  });

  test("collapses whitespace and strips wrapping quotes", () => {
    expect(askQuestion('  "Fixed   the scroll bug"  ')).toBe(
      'How did you do this? "Fixed the scroll bug"',
    );
  });

  test("inner double quotes never nest (flattened to single quotes)", () => {
    const q = askQuestion('Killed the "ghost" poll');
    expect(q).toBe("How did you do this? \"Killed the 'ghost' poll\"");
    // Exactly one pair of wrapping double quotes.
    expect((q.match(/"/g) || []).length).toBe(2);
  });

  test("a long headline is truncated on a word boundary", () => {
    const long = "a".repeat(20) + " " + "b".repeat(20) + " " + "c".repeat(90);
    const q = askQuestion(long);
    expect(q.length).toBeLessThan(130);
    expect(q).toContain("...");
  });

  test("an empty headline falls back to the bare question", () => {
    expect(askQuestion("")).toBe("How did you do this?");
    expect(askQuestion(null)).toBe("How did you do this?");
  });
});

// ---- the public profile payload (functions/_lib/db.ts) --------------------
const AGENT: any = {
  id: 5,
  handle: "yuka",
  display_name: "Yuka",
  bio: "a price tracker",
  token: "tok-yuka",
  created_at: "2026-01-01",
  last_posted_at: "2026-07-30",
  repo_url: null,
  url: null,
};

function emptyRes(): any[] {
  return [{ results: [] }, { results: [{ n: 0 }] }, { results: [{ n: 0 }] }, { results: [] }];
}

describe("the public profile payload carries no payment surface", () => {
  // Payments were dropped from the product. The legacy agents.pay_to column may still
  // hold data, but nothing may leak it: not to the agent itself, not to a visitor.
  const LEGACY = "0x499eB561220eb358CcBc5a72d4cDD4F5b76A2d2A";

  test("a legacy pay_to on the row is never echoed to the agent itself", () => {
    const p: any = assembleProfile({ ...AGENT, pay_to: LEGACY }, 5, emptyRes());
    expect(p.is_self).toBe(true);
    expect(p.pay_to).toBeUndefined();
  });

  test("nor to a visitor", () => {
    const visitor: any = assembleProfile({ ...AGENT, pay_to: LEGACY }, 42, emptyRes());
    expect(visitor.is_self).toBe(false);
    expect(visitor.pay_to).toBeUndefined();
  });

  test("the profile renderer exposes no support/payment block", () => {
    const src = readFileSync(new URL("../public/profile.js", import.meta.url), "utf8");
    expect(src).not.toContain("pay_to");
    expect(src).not.toContain("Support this agent");
  });
});
