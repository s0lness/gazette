import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// The profile editor is ONE shared implementation in the browser file
// public/profile-edit.js (attached to window.gzProfileEdit): the pure helpers, the
// markup builders, and the live modal. profile.js only decides where the button goes.
// We load the source, stub a minimal window/document so the IIFE evaluates without a
// DOM, and pull the exports off the stub. This is the SAME code the live modal plans
// its POST with, so the partial-update diff and the client-side validation are tested
// against the real mirrors of the server's rules in functions/api/[token]/profile.ts
// and image.ts.
function loadProfileEdit() {
  const src = readFileSync(new URL("../public/profile-edit.js", import.meta.url), "utf8");
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
    ...over,
  };
}

describe("profileValues", () => {
  test("normalizes nulls to empty strings", () => {
    const v = PE.profileValues({
      display_name: null,
      bio: "  hello  ",
      repo_url: null,
      url: null,
    });
    expect(v).toEqual({
      display_name: "",
      bio: "hello",
      repo_url: "",
      url: "",
    });
  });

  test("the pin is NOT an editor value: it is set from the post's own menu", () => {
    // A payload carrying a pinned card must not leak pinned_daily_id into the form.
    const v = PE.profileValues({ display_name: "Yuka", pinned: { id: 7, headline: "shipped" } });
    expect(v.pinned_daily_id).toBeUndefined();
    expect(Object.keys(v).sort()).toEqual(["bio", "display_name", "repo_url", "url"]);
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

  test("the editor never sends a pin: that is the post menu's job", () => {
    expect(PE.diffProfile(values(), values({ pinned_daily_id: 12 }))).toEqual({});
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

// The Follow slot on your own profile. profile.js renders whatever this returns in
// place of the Follow button, so "" is the guarantee that nobody else's profile can
// ever show it.
describe("buttonHTML (Edit profile, own profile only)", () => {
  test("renders only when is_self", () => {
    const own = PE.buttonHTML({ handle: "gazette", is_self: true });
    expect(own).toContain("Edit profile");
    expect(own).toContain('id="edit-profile-btn"');
    // Same pill geometry as Follow, quiet variant.
    expect(own).toContain("follow-btn");
    expect(own).toContain("pe-edit-btn");
  });

  test("renders nothing on someone else's profile, or with no payload", () => {
    expect(PE.buttonHTML({ handle: "other", is_self: false })).toBe("");
    expect(PE.buttonHTML({ handle: "other" })).toBe("");
    expect(PE.buttonHTML(null)).toBe("");
  });
});

describe("modalHTML (the editor dialog's markup)", () => {
  const state = (over: Record<string, any> = {}) => ({
    handle: "gazette",
    values: values(),
    errors: {},
    avatarBust: 0,
    hasToken: true,
    ...over,
  });

  test("is a wall-modal dialog titled Edit profile, with a backdrop and a close X", () => {
    const html = PE.modalHTML(state());
    expect(html).toContain("wall-modal-backdrop");
    expect(html).toContain("pe-backdrop");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Edit profile");
    expect(html).toContain("pe-x");
  });

  test("carries every field, the counter, Cancel and a disabled Save", () => {
    const html = PE.modalHTML(state());
    expect(html).toContain('id="pe-display_name"');
    expect(html).toContain('id="pe-bio"');
    expect(html).toContain('id="pe-repo_url"');
    expect(html).toContain('id="pe-url"');
    expect(html).toContain("Change photo");
    expect(html).toContain('class="pe-count"');
    expect(html).toContain("pe-cancel");
    expect(html).toContain('class="pe-save primary" disabled');
  });

  test("has NO pinned-post picker: pinning moved onto the post itself", () => {
    const html = PE.modalHTML(state());
    expect(html).not.toContain("pe-pinned_daily_id");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Pinned post");
  });

  test("paints the current values and the avatar", () => {
    const html = PE.modalHTML(state({ avatarBust: 1234 }));
    expect(html).toContain('value="Yuka"');
    expect(html).toContain("ships things");
    expect(html).toContain("/avatar/gazette?t=1234");
  });

  test("escapes hostile values instead of injecting them", () => {
    const html = PE.modalHTML(state({ values: values({ display_name: '"><img src=x onerror=1>' }) }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("shows an inline error next to its own field", () => {
    const html = PE.modalHTML(state({ errors: { bio: "Description is too long." } }));
    expect(html).toContain('data-err="bio"');
    expect(html).toContain("Description is too long.");
    // The error slot is only hidden when there is nothing to say.
    expect(html).toContain('data-err="url" hidden');
  });

  test("a cookie-only session gets the token note instead of the form", () => {
    const html = PE.modalHTML(state({ hasToken: false }));
    expect(html).toContain("token");
    expect(html).toContain("pe-token-note");
    expect(html).not.toContain('id="pe-display_name"');
    expect(html).not.toContain("pe-save");
    // Still a real, closable dialog.
    expect(html).toContain('role="dialog"');
    expect(html).toContain("pe-cancel");
  });
});

// Pinning moved OFF the editor and ONTO the post, Twitter-style: the card's share menu
// carries "Pin to profile" on a post you authored. The menu builder lives in
// public/tweet.js (window.gzTweet.shareMenuHTML) and is loaded the same way.
function loadTweet(): any {
  const src = readFileSync(new URL("../public/tweet.js", import.meta.url), "utf8");
  const win: any = {};
  const doc: any = { addEventListener: () => {}, createElement: () => ({}) };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzTweet;
}

const TW = loadTweet();

describe("share menu: Pin to profile", () => {
  test("Copy link and Quote are always there", () => {
    const html = TW.shareMenuHTML(null);
    expect(html).toContain("Copy link");
    expect(html).toContain("Quote");
  });

  test("no pin item unless the card is a pinnable post of yours", () => {
    // pinStateFor returns null for replies, other agents' posts and pending cards, and
    // that null is what reaches the builder.
    const html = TW.shareMenuHTML(null);
    expect(html).not.toContain("tw-share-pin");
    expect(html).not.toContain("profile");
  });

  test("an unpinned post of yours offers Pin to profile", () => {
    const html = TW.shareMenuHTML("pin");
    expect(html).toContain("tw-share-pin");
    expect(html).toContain("Pin to profile");
    expect(html).not.toContain("Unpin");
    expect(html).toContain('role="menuitem"');
  });

  test("the post that is already pinned offers Unpin from profile", () => {
    const html = TW.shareMenuHTML("unpin");
    expect(html).toContain("tw-share-pin");
    expect(html).toContain("Unpin from profile");
  });

  test("the pinned-post hint is readable and clearable", () => {
    expect(typeof TW.setPinned).toBe("function");
    expect(typeof TW.getPinned).toBe("function");
    // No localStorage in the stub: the helper degrades to "nothing pinned" instead of
    // throwing, so a card menu still renders.
    expect(() => TW.setPinned(12)).not.toThrow();
    expect(TW.getPinned()).toBe(null);
  });
});

describe("avatarSrcFor (cache-busting a fresh photo)", () => {
  test("lowercases the handle and adds the bust only when there is one", () => {
    expect(PE.avatarSrcFor("Gazette", 0)).toBe("/avatar/gazette");
    expect(PE.avatarSrcFor("Gazette", 77)).toBe("/avatar/gazette?t=77");
  });
});
