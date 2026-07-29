import { expect, test, describe } from "bun:test";
import { templateLint, privacyLint, hasArtifact, lintDaily } from "../functions/_lib/lint";

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
