import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// diffFeed + contentHash live in the browser file public/feed.js (attached to
// window.gzFeedDiff). We load the source, stub a minimal window/document so the IIFE
// evaluates without a DOM, and pull the pure helpers off the stub. This is the SAME
// code the live incremental repaint (applyDiff) plans against.
function loadFeedDiff(): {
  diffFeed: (entries: any[], prevHashes: Map<any, string>) => any;
  contentHash: (e: any) => string;
} {
  const src = readFileSync(new URL("../public/feed.js", import.meta.url), "utf8");
  const win: any = {};
  const doc: any = {
    readyState: "complete",
    addEventListener: () => {},
    createElement: () => ({}),
    getElementById: () => null,
    documentElement: { getAttribute: () => null },
  };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzFeedDiff;
}

const { diffFeed, contentHash } = loadFeedDiff();

// A minimal feed entry (only the fields contentHash reads matter).
function entry(over: Record<string, any> = {}) {
  return {
    id: 1, headline: "shipped it", status: "active", display_name: "Yuka",
    edited_at: null, image_id: null, likes: 0, liked: false, comment_count: 0, saved: false,
    ...over,
  };
}

function hashMap(entries: any[]) {
  const m = new Map<any, string>();
  for (const e of entries) m.set(e.id, contentHash(e));
  return m;
}

describe("feed diff planner", () => {
  test("unchanged: no ops", () => {
    const entries = [entry({ id: 1 }), entry({ id: 2 })];
    const plan = diffFeed(entries, hashMap(entries));
    expect(plan.inserts).toEqual([]);
    expect(plan.replaces).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(plan.order).toEqual([1, 2]);
  });

  test("insert: a genuinely new post at the top", () => {
    const prev = [entry({ id: 2 })];
    const next = [entry({ id: 3 }), entry({ id: 2 })];
    const plan = diffFeed(next, hashMap(prev));
    expect(plan.inserts).toEqual([{ id: 3, index: 0 }]);
    expect(plan.replaces).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(plan.order).toEqual([3, 2]);
  });

  test("replace: only the card whose content changed", () => {
    const prev = [entry({ id: 1, likes: 0 }), entry({ id: 2, comment_count: 0 })];
    const next = [entry({ id: 1, likes: 5 }), entry({ id: 2, comment_count: 0 })];
    const plan = diffFeed(next, hashMap(prev));
    expect(plan.inserts).toEqual([]);
    expect(plan.replaces).toEqual([1]);
    expect(plan.removes).toEqual([]);
  });

  test("replace triggers on viewer_liked / comment_count / headline / edited flips", () => {
    const base = entry({ id: 1 });
    const prevH = contentHash(base);
    expect(contentHash({ ...base, liked: true })).not.toBe(prevH);
    expect(contentHash({ ...base, comment_count: 1 })).not.toBe(prevH);
    expect(contentHash({ ...base, headline: "changed" })).not.toBe(prevH);
    expect(contentHash({ ...base, edited_at: "2026-08-01T00:00:00Z" })).not.toBe(prevH);
    expect(contentHash({ ...base, saved: true })).not.toBe(prevH);
    expect(contentHash({ ...base, image_id: "abc" })).not.toBe(prevH);
  });

  test("replace triggers when a PREVIEWED REPLY's like state changes", () => {
    // Inline replies are full tweet cards with their own hearts, so a like landing on a
    // reply must repaint the host card even though the post's own counts are untouched.
    const preview = (over: Record<string, any> = {}) => [
      { id: 101, likes: 0, liked: 0, ...over },
      { id: 102, likes: 4, liked: 0 },
    ];
    const base = entry({ id: 1, comment_count: 2, comments_preview: preview() });
    const prevH = contentHash(base);
    // The viewer likes reply 101: tally + own-like both move.
    expect(contentHash(entry({ id: 1, comment_count: 2, comments_preview: preview({ likes: 1, liked: 1 }) }))).not.toBe(prevH);
    // Someone ELSE likes it: only the tally moves, and that still repaints.
    expect(contentHash(entry({ id: 1, comment_count: 2, comments_preview: preview({ likes: 1 }) }))).not.toBe(prevH);
    // An identical payload keeps the same hash (no needless repaint).
    expect(contentHash(entry({ id: 1, comment_count: 2, comments_preview: preview() }))).toBe(prevH);

    const plan = diffFeed(
      [entry({ id: 1, comment_count: 2, comments_preview: preview({ likes: 1, liked: 1 }) })],
      new Map([[1, prevH]]),
    );
    expect(plan.replaces).toEqual([1]);
  });

  test("remove: a post that disappeared", () => {
    const prev = [entry({ id: 1 }), entry({ id: 2 })];
    const next = [entry({ id: 1 })];
    const plan = diffFeed(next, hashMap(prev));
    expect(plan.inserts).toEqual([]);
    expect(plan.replaces).toEqual([]);
    expect(plan.removes).toEqual([2]);
    expect(plan.order).toEqual([1]);
  });

  test("mixed: insert + replace + remove in one pass", () => {
    const prev = [entry({ id: 1, likes: 0 }), entry({ id: 2 }), entry({ id: 3 })];
    const next = [entry({ id: 4 }), entry({ id: 1, likes: 9 }), entry({ id: 2 })];
    const plan = diffFeed(next, hashMap(prev));
    expect(plan.inserts).toEqual([{ id: 4, index: 0 }]);
    expect(plan.replaces).toEqual([1]);
    expect(plan.removes).toEqual([3]);
    expect(plan.order).toEqual([4, 1, 2]);
    // The new hash map reflects exactly the next entries.
    expect(Array.from(plan.hashes.keys()).sort()).toEqual([1, 2, 4]);
  });
});
