import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// The "My agent" profile editor's pure helpers live in the browser file
// public/my-agent.js (attached to window.gzProfileEdit). We load the source, stub a
// minimal window/document so the IIFE evaluates without a DOM, and pull the helpers
// off the stub. This is the SAME code the live form plans its POST with, so the
// partial-update diff and the client-side validation are tested against the real
// mirrors of the server's rules in functions/api/[token]/profile.ts and image.ts.
function loadProfileEdit() {
  const src = readFileSync(new URL("../public/my-agent.js", import.meta.url), "utf8");
  const win: any = { gzToken: () => "", gzMe: () => null };
  const doc: any = {
    readyState: "complete",
    addEventListener: () => {},
    createElement: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    documentElement: { getAttribute: () => null },
  };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzProfileEdit;
}

const PE = loadProfileEdit();

function values(over: Record<string, any> = {}) {
  return {
    display_name: "Yuka",
    bio: "ships things",
    repo_url: "https://github.com/s0lness/gazette",
    url: "https://gazette.sylve.org",
    pinned_daily_id: null,
    ...over,
  };
}

describe("profileValues", () => {
  test("normalizes nulls to empty strings and reads the pin from the pinned card", () => {
    const v = PE.profileValues({
      display_name: null,
      bio: "  hello  ",
      repo_url: null,
      url: null,
      pinned: { id: 7, headline: "shipped" },
    });
    expect(v).toEqual({
      display_name: "",
      bio: "hello",
      repo_url: "",
      url: "",
      pinned_daily_id: 7,
    });
  });

  test("no pinned card means no pin", () => {
    expect(PE.profileValues({ pinned: null }).pinned_daily_id).toBe(null);
  });
});

describe("diffProfile (only changed fields are sent)", () => {
  test("no change yields an empty body", () => {
    expect(PE.diffProfile(values(), values())).toEqual({});
  });

  test("only the edited field is included", () => {
    const d = PE.diffProfile(values(), values({ bio: "ships better things" }));
    expect(d).toEqual({ bio: "ships better things" });
  });

  test("whitespace-only edits are not a change", () => {
    expect(PE.diffProfile(values(), values({ bio: "  ships things  " }))).toEqual({});
  });

  test("clearing a field sends an empty string (the endpoint's 'clear' intent)", () => {
    const d = PE.diffProfile(values(), values({ repo_url: "" }));
    expect(d).toEqual({ repo_url: "" });
  });

  test("pin changes send a number, clearing sends null", () => {
    expect(PE.diffProfile(values(), values({ pinned_daily_id: 12 }))).toEqual({ pinned_daily_id: 12 });
    expect(PE.diffProfile(values({ pinned_daily_id: 12 }), values({ pinned_daily_id: null }))).toEqual({
      pinned_daily_id: null,
    });
    expect(PE.diffProfile(values({ pinned_daily_id: 12 }), values({ pinned_daily_id: 12 }))).toEqual({});
  });

  test("several edits at once are all included, untouched fields are not", () => {
    const d = PE.diffProfile(values(), values({ display_name: "Yuka II", url: "https://yuka.dev" }));
    expect(Object.keys(d).sort()).toEqual(["display_name", "url"]);
  });
});

describe("validateProfile (client mirror of the server's rules)", () => {
  test("a valid set of values has no errors", () => {
    expect(PE.validateProfile(values())).toEqual({});
  });

  test("bio over FIELD_MAX is flagged on the bio field", () => {
    const e = PE.validateProfile(values({ bio: "a".repeat(PE.FIELD_MAX + 1) }));
    expect(e.bio).toContain(String(PE.FIELD_MAX));
    expect(Object.keys(e)).toEqual(["bio"]);
  });

  test("bio exactly at FIELD_MAX passes", () => {
    expect(PE.validateProfile(values({ bio: "a".repeat(PE.FIELD_MAX) })).bio).toBeUndefined();
  });

  test("display name over NAME_MAX, or multi-line, is flagged", () => {
    expect(PE.validateProfile(values({ display_name: "a".repeat(PE.NAME_MAX + 1) })).display_name).toBeTruthy();
    expect(PE.validateProfile(values({ display_name: "a\nb" })).display_name).toBeTruthy();
    expect(PE.validateProfile(values({ display_name: "a".repeat(PE.NAME_MAX) })).display_name).toBeUndefined();
  });

  test("links must be full http(s) URLs", () => {
    expect(PE.validateProfile(values({ repo_url: "github.com/x/y" })).repo_url).toBeTruthy();
    expect(PE.validateProfile(values({ url: "ftp://nope" })).url).toBeTruthy();
    expect(PE.validateProfile(values({ url: "http://x.dev" })).url).toBeUndefined();
  });

  test("an empty link is fine (it clears the field)", () => {
    expect(PE.validateProfile(values({ repo_url: "", url: "" }))).toEqual({});
  });

  test("the form has no payment surface: pay_to is never diffed or validated", () => {
    // The x402 payout field was dropped from the product; the editor must not send it.
    expect(PE.diffProfile(values(), { ...values(), pay_to: "0xdead" })).toEqual({});
    expect(PE.validateProfile({ ...values(), pay_to: "nonsense" })).toEqual({});
  });
});

describe("checkImageFile (the server's caps, enforced before the upload)", () => {
  const file = (type: string, size: number) => ({ type, size });

  test("accepts a small PNG", () => {
    expect(PE.checkImageFile(file("image/png", 40 * 1024))).toBe(null);
  });

  test("rejects a non-image type", () => {
    expect(PE.checkImageFile(file("application/pdf", 1000))).toContain("PNG");
  });

  test("rejects a PNG over the 800 KB cap, accepts one just under", () => {
    expect(PE.checkImageFile(file("image/png", 800 * 1024 + 1))).toContain("limit");
    expect(PE.checkImageFile(file("image/png", 800 * 1024))).toBe(null);
  });

  test("GIF gets the 4 MB cap and SVG the 100 KB cap", () => {
    expect(PE.checkImageFile(file("image/gif", 3 * 1024 * 1024))).toBe(null);
    expect(PE.checkImageFile(file("image/gif", 4 * 1024 * 1024 + 1))).toContain("limit");
    expect(PE.checkImageFile(file("image/svg+xml", 90 * 1024))).toBe(null);
    expect(PE.checkImageFile(file("image/svg+xml", 100 * 1024 + 1))).toContain("limit");
  });

  test("a content-type with parameters still resolves its cap", () => {
    expect(PE.checkImageFile(file("image/jpeg; charset=binary", 1000))).toBe(null);
  });

  test("an empty file and a missing file are refused", () => {
    expect(PE.checkImageFile(file("image/png", 0))).toBeTruthy();
    expect(PE.checkImageFile(null)).toBeTruthy();
  });
});
