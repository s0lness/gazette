import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// pickDiscussed (selection + never-empty backfill) lives in the browser file
// public/feed.js, attached to window.gzDiscuss. We load the source, stub a minimal
// window/document so the IIFE evaluates without a DOM, and pull the pure helper off the
// stub. This is the SAME function the live "Being discussed" strip renders from.
function loadDiscuss(): { pickDiscussed: (entries: any[], now?: number) => any[] } {
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
  return win.gzDiscuss;
}

const { pickDiscussed } = loadDiscuss();

const NOW = Date.parse("2026-08-01T12:00:00Z");
function isoAgo(hours: number) {
  return new Date(NOW - hours * 3600 * 1000).toISOString();
}

// Minimal entry; only the fields pickDiscussed reads matter.
function entry(over: Record<string, any> = {}) {
  return {
    id: 1, handle: "yuka", headline: "shipped it",
    comment_count: 0, likes: 0, last_comment_at: null, created_at: isoAgo(1),
    ...over,
  };
}

describe("Being-discussed selection + backfill", () => {
  test("qualifying only: recent-discussion posts ranked by newest activity", () => {
    const entries = [
      entry({ id: 1, comment_count: 2, last_comment_at: isoAgo(5) }),
      entry({ id: 2, comment_count: 9, last_comment_at: isoAgo(1) }),
      entry({ id: 3, comment_count: 1, last_comment_at: isoAgo(10) }),
    ];
    const picks = pickDiscussed(entries, NOW);
    expect(picks.map((p) => p.id)).toEqual([2, 1, 3]); // newest activity first
    expect(picks.every((p) => p._recent === true)).toBe(true);
  });

  test("posts with a comment older than 48h do NOT qualify as recent (but can backfill)", () => {
    const entries = [
      entry({ id: 1, comment_count: 3, last_comment_at: isoAgo(60) }), // stale discussion
      entry({ id: 2, comment_count: 0, likes: 4 }),
    ];
    const picks = pickDiscussed(entries, NOW);
    // Neither is a recent discussion, so both are backfilled (none marked _recent).
    expect(picks.every((p) => p._recent === false)).toBe(true);
    // Backfill ranks by comment_count first: the stale-but-commented post leads.
    expect(picks[0].id).toBe(1);
  });

  test("backfill fills to 3 by engagement when fewer than 3 qualify", () => {
    const entries = [
      entry({ id: 1, comment_count: 2, last_comment_at: isoAgo(2) }), // recent -> slot 1
      entry({ id: 2, comment_count: 5, last_comment_at: null }),      // backfill by comments
      entry({ id: 3, comment_count: 0, likes: 8 }),                    // backfill by likes
      entry({ id: 4, comment_count: 0, likes: 1 }),                    // backfill, lower likes
    ];
    const picks = pickDiscussed(entries, NOW);
    expect(picks.length).toBe(3);
    expect(picks[0].id).toBe(1); // the genuine recent discussion leads
    expect(picks[0]._recent).toBe(true);
    // Then backfill by comment_count (2) then likes (3 over 4).
    expect(picks.slice(1).map((p) => p.id)).toEqual([2, 3]);
    expect(picks.slice(1).every((p) => p._recent === false)).toBe(true);
  });

  test("caps at 3 even when more than 3 qualify", () => {
    const entries = [1, 2, 3, 4, 5].map((id) =>
      entry({ id, comment_count: id, last_comment_at: isoAgo(id) })
    );
    expect(pickDiscussed(entries, NOW).length).toBe(3);
  });

  test("zero posts renders nothing (empty selection)", () => {
    expect(pickDiscussed([], NOW)).toEqual([]);
    expect(pickDiscussed(undefined as any, NOW)).toEqual([]);
  });

  test("no post is picked twice (recent + backfill de-duplicated)", () => {
    const entries = [
      entry({ id: 1, comment_count: 4, likes: 9, last_comment_at: isoAgo(3) }),
      entry({ id: 2, comment_count: 0, likes: 1 }),
    ];
    const picks = pickDiscussed(entries, NOW);
    const ids = picks.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
