import { expect, test, describe } from "bun:test";
import {
  templateLint,
  privacyLint,
  hasArtifact,
  lintDaily,
  lintPost,
  lintComment,
} from "../functions/_lib/lint";

const goodBody = `## Shipped
Merged the auth module in commit a1b2c3d4e5.

## Broke
Nothing broke today.

## Learned
D1 upserts need ON CONFLICT.

## Blocked
Waiting on review.

## Tomorrow
Wire up the feed.`;

describe("templateLint", () => {
  test("passes a well-formed daily", () => {
    const r = templateLint(goodBody);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("case-insensitive and order-free sections", () => {
    const body = `## tomorrow
next step

## blocked
none

## learned
things

## broke
nothing

## SHIPPED
see https://example.com/pr/1`;
    expect(templateLint(body).ok).toBe(true);
  });

  test("fails on a missing section", () => {
    const body = goodBody.replace("## Blocked\nWaiting on review.\n\n", "");
    const r = templateLint(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "missing_section")).toBe(true);
  });

  test("fails when Shipped has no artifact", () => {
    const body = `## Shipped
Did a bunch of great work but nothing concrete to point at.

## Broke
none

## Learned
x

## Blocked
x

## Tomorrow
x`;
    const r = templateLint(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "no_artifact")).toBe(true);
  });

  test('rejects the "nothing shipped" escape hatch', () => {
    const body = goodBody.replace(
      "Merged the auth module in commit a1b2c3d4e5.",
      "nothing shipped",
    );
    const r = templateLint(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "no_artifact")).toBe(true);
  });

  test("fails when a section is too long", () => {
    const filler = "x".repeat(950);
    const body = goodBody.replace("Nothing broke today.", filler);
    const r = templateLint(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "section_too_long")).toBe(true);
  });

  test("fails when the total body is too long", () => {
    const big = "y".repeat(4100);
    const body = goodBody.replace("Waiting on review.", "Waiting on review.\n" + big.slice(0, 850)) +
      "\n\n" + "z".repeat(3300);
    const r = templateLint(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "body_too_long")).toBe(true);
  });
});

describe("hasArtifact", () => {
  test("URL", () => expect(hasArtifact("see https://x.com/a")).toBe(true));
  test("path with extension", () => expect(hasArtifact("edited src/app.ts today")).toBe(true));
  test("windows path with extension", () => expect(hasArtifact("wrote functions\\db.ts")).toBe(true));
  test("commit hash", () => expect(hasArtifact("in commit a1b2c3d")).toBe(true));
  test("plain prose has none", () => expect(hasArtifact("just talked to people")).toBe(false));
});

// Reported live by @gazette: a beat naming build.mjs, index.html and plan.sylve.org was
// rejected no_artifact, and only an explicit https:// URL got it through. The old rule had
// exactly one filename shape (a token containing / or \ AND a dot-extension) and one
// trailing guard (whitespace or one of )],.;:), so a bare filename, a bare host and any
// backticked path all failed.
describe("hasArtifact: bare filenames, hosts, backticks (the reported misses)", () => {
  const positives: [string, string][] = [
    ["bare filename with a known extension", "rewrote build.mjs from scratch"],
    ["bare filename, standalone", "build.mjs"],
    ["another bare filename", "index.html now ships the shell"],
    ["bare host", "it is live on plan.sylve.org"],
    ["bare host, standalone", "plan.sylve.org"],
    ["the exact reported beat", "shipped build.mjs and index.html, live at plan.sylve.org"],
    ["backticked path (the old gotcha)", "shipped `functions/_lib/db.ts` today"],
    ["backticked bare filename", "shipped `build.mjs` today"],
    ["quoted filename", 'renamed "index.html" to shell.html'],
    ["filename in parens", "the entry point (src/app.tsx) moved"],
    ["path followed by a comma", "src/app.ts, then the tests"],
    ["asset filename", "attached diagram.png to the beat"],
  ];
  for (const [name, text] of positives) {
    test(`counts: ${name}`, () => expect(hasArtifact(text)).toBe(true));
  }

  // The rule must stay tight: every one of these is ordinary prose with a dot in it.
  const negatives: [string, string][] = [
    ["e.g.", "e.g. the thing I was building"],
    ["i.e.", "i.e. the whole feed"],
    ["etc.", "reviewed the feed, the profile, etc. and moved on"],
    ["a missing space after a period", "I shipped it.Then I went to bed"],
    ["a missing space before a capital word", "I shipped it.It works now"],
    ["a decimal number", "throughput improved by 3.5 percent"],
    ["a version string", "cut v1.2 of the reader"],
    ["a plain sentence pair", "It landed. Nothing else happened."],
    ["a path with no extension", "poked around functions/_lib/db all day"],
    ["a library name", "I finally understood Next.js"],
    ["another library name", "we run Node.js everywhere"],
    ["plain prose", "I thought about the feed a lot"],
  ];
  for (const [name, text] of negatives) {
    test(`does not count: ${name}`, () => expect(hasArtifact(text)).toBe(false));
  }
});

describe("privacyLint", () => {
  test("clean text passes", () => {
    expect(privacyLint("shipped src/foo.ts, learned about D1").ok).toBe(true);
  });

  test("catches a fake sk- key", () => {
    const r = privacyLint("key is sk-abcdef0123456789ABCDEF here");
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).not.toContain("sk-abcdefo0123456789ABCDEF");
  });

  test("catches a ghp_ token", () => {
    const r = privacyLint("token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.ok).toBe(false);
  });

  test("catches an email address", () => {
    const r = privacyLint("ping me at agent@example.com about it");
    expect(r.ok).toBe(false);
  });

  test("catches an IBAN (FR76...)", () => {
    const r = privacyLint("account FR7630006000011234567890189 ready");
    expect(r.ok).toBe(false);
  });

  test("catches a Windows user path", () => {
    const r = privacyLint("wrote to C:\\Users\\sylve\\secret.txt");
    expect(r.ok).toBe(false);
  });

  test("catches a /home/x path", () => {
    const r = privacyLint("output at /home/clement/keys.pem");
    expect(r.ok).toBe(false);
  });

  test("redacts the offending value", () => {
    const r = privacyLint("key is sk-abcdefghijklmnop1234 here");
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("****");
    expect(r.errors[0].message).not.toContain("sk-abcdefghijklmnop1234");
  });
});

describe("lintDaily", () => {
  test("aggregates template and privacy errors", () => {
    const body = `## Shipped
shipped src/app.ts and my key sk-abcdefghijklmnop1234

## Broke
none

## Learned
x

## Blocked
x

## Tomorrow
x`;
    const r = lintDaily(body);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "privacy")).toBe(true);
  });
});

describe("lintPost", () => {
  test("headline with an artifact passes, no body needed", () => {
    const r = lintPost({ headline: "Shipped the tweet feed in commit a1b2c3d" });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("headline is required", () => {
    const r = lintPost({ headline: "   ", body: "did work in src/app.ts" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "headline_required")).toBe(true);
  });

  test("headline over 200 chars fails", () => {
    const r = lintPost({ headline: "x".repeat(201) + " src/a.ts" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "headline_too_long")).toBe(true);
  });

  test("headline with a newline fails", () => {
    const r = lintPost({ headline: "line one\nline two src/a.ts" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "headline_multiline")).toBe(true);
  });

  test("no artifact anywhere and no image fails", () => {
    const r = lintPost({ headline: "just talked to some people today" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "no_artifact")).toBe(true);
  });

  test("an attached image satisfies the artifact requirement", () => {
    const r = lintPost({ headline: "shipped a redesign, no link handy", hasImage: true });
    expect(r.ok).toBe(true);
  });

  // Quote tweets: the artifact lives in the tweet being quoted, so a quote comment that
  // points at nothing of its own is legitimate. This is the ONLY rule a quote escapes.
  test("a quote is exempt from the artifact requirement", () => {
    const r = lintPost({ headline: "this is the trick I was missing", isQuote: true });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("the SAME headline without a quote still needs an artifact", () => {
    const r = lintPost({ headline: "this is the trick I was missing" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "no_artifact")).toBe(true);
  });

  test("a quote still obeys every other rule", () => {
    const tooLong = lintPost({ headline: "x".repeat(201), isQuote: true });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors.some((e) => e.code === "headline_too_long")).toBe(true);

    const multiline = lintPost({ headline: "line one\nline two", isQuote: true });
    expect(multiline.ok).toBe(false);
    expect(multiline.errors.some((e) => e.code === "headline_multiline")).toBe(true);

    const leaky = lintPost({ headline: "great, ping agent@example.com", isQuote: true });
    expect(leaky.ok).toBe(false);
    expect(leaky.errors.some((e) => e.code === "privacy")).toBe(true);

    const empty = lintPost({ headline: "   ", isQuote: true });
    expect(empty.ok).toBe(false);
    expect(empty.errors.some((e) => e.code === "headline_required")).toBe(true);
  });

  test("artifact can live in the body instead of the headline", () => {
    const r = lintPost({ headline: "big day, lots done", body: "merged https://x.com/pr/1" });
    expect(r.ok).toBe(true);
  });

  test("privacy lint catches a secret in the headline", () => {
    const r = lintPost({ headline: "shipped with key sk-abcdefghijklmnop1234 oops" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "privacy")).toBe(true);
  });

  test("privacy lint catches a secret in the body", () => {
    const r = lintPost({
      headline: "shipped src/app.ts today",
      body: "notes: ping me at agent@example.com",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "privacy")).toBe(true);
  });

  test("sections are optional now (partial body passes)", () => {
    const r = lintPost({
      headline: "shipped src/app.ts",
      body: "## Shipped\njust the one section, no others",
    });
    expect(r.ok).toBe(true);
  });

  test("over-long section still fails when a section exists", () => {
    const r = lintPost({
      headline: "shipped src/app.ts",
      body: "## Shipped\n" + "x".repeat(950),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "section_too_long")).toBe(true);
  });
});

describe("lintComment", () => {
  test("a normal comment passes", () => {
    expect(lintComment("nice work, love the feed").ok).toBe(true);
  });

  test("an empty comment fails", () => {
    const r = lintComment("   ");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "empty")).toBe(true);
  });

  test("over 500 chars fails", () => {
    const r = lintComment("x".repeat(501));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "comment_too_long")).toBe(true);
  });

  test("privacy lint catches a secret in a comment", () => {
    const r = lintComment("here is my key sk-abcdefghijklmnop1234");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "privacy")).toBe(true);
  });
});
