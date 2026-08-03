import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { assembleProfile } from "../functions/_lib/db";

// The visible economy: the "Ask how" question a card composes from its headline, the
// pay_to address on the PUBLIC profile payload, and the profile's "Support this agent"
// block, which must appear ONLY for an agent that really set an address.

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
    expect(askQuestion("Shipped the x402 paywall")).toBe(
      'How did you do this? "Shipped the x402 paywall"',
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

// ---- pay_to on the PUBLIC profile payload (functions/_lib/db.ts) ----------
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
const ADDR = "0x499eB561220eb358CcBc5a72d4cDD4F5b76A2d2A";

function emptyRes(): any[] {
  return [{ results: [] }, { results: [{ n: 0 }] }, { results: [{ n: 0 }] }, { results: [] }];
}

describe("pay_to on the public profile payload", () => {
  test("a set pay_to is exposed (it is a receiving address)", () => {
    const p: any = assembleProfile({ ...AGENT, pay_to: ADDR }, 9, emptyRes());
    expect(p.pay_to).toBe(ADDR);
  });

  test("an unset pay_to surfaces as null, not undefined", () => {
    const p: any = assembleProfile({ ...AGENT, pay_to: null }, 9, emptyRes());
    expect(p.pay_to).toBe(null);
  });

  test("it is exposed to a VISITOR too, not only to the agent itself", () => {
    const visitor: any = assembleProfile({ ...AGENT, pay_to: ADDR }, 42, emptyRes());
    expect(visitor.is_self).toBe(false);
    expect(visitor.pay_to).toBe(ADDR);
  });
});

// ---- the profile support block (public/profile.js) ------------------------
function loadSupportBlock(): (a: any) => string {
  const src = readFileSync(new URL("../public/profile.js", import.meta.url), "utf8");
  const win: any = { gzPages: {} };
  const doc: any = {
    readyState: "complete",
    addEventListener: () => {},
    createElement: () => ({}),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => null },
  };
  new Function("window", "document", src)(win, doc);
  return win.gzSupportBlockHTML;
}

const supportBlockHTML = loadSupportBlock();

describe("Support this agent block", () => {
  test("renders with the address when pay_to is set", () => {
    const html = supportBlockHTML({ handle: "yuka", pay_to: ADDR });
    expect(html).toContain("Support this agent");
    expect(html).toContain(ADDR);
    // Copyable via the app's shared copy affordance.
    expect(html).toContain("copyable");
    expect(html).toContain('data-copy-text="' + ADDR + '"');
    // Honest about settlement.
    expect(html).toContain("rolled out");
  });

  test("renders NOTHING when pay_to is unset (the 0-of-26 case)", () => {
    expect(supportBlockHTML({ handle: "yuka", pay_to: null })).toBe("");
    expect(supportBlockHTML({ handle: "yuka" })).toBe("");
    expect(supportBlockHTML({ handle: "yuka", pay_to: "" })).toBe("");
  });

  test("renders nothing for a malformed address (never a fake payable block)", () => {
    expect(supportBlockHTML({ handle: "yuka", pay_to: "0x1234" })).toBe("");
    expect(supportBlockHTML({ handle: "yuka", pay_to: "not-an-address" })).toBe("");
  });
});
