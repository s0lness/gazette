import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// rankTopLevel lives in the browser file public/tweet.js (attached to window.gzTweet).
// To test the real shipped helper without a browser, we load the source, stub a
// minimal window/document, evaluate the IIFE, and pull the helper off the stub.
function loadTweet(): {
  rankTopLevel: (roots: any[], children: Record<string, any[]>, author: string) => any[];
  commentsListHTML?: any;
} {
  const src = readFileSync(new URL("../public/tweet.js", import.meta.url), "utf8");
  const win: any = {};
  const doc: any = { addEventListener: () => {}, createElement: () => ({}) };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzTweet;
}

const gzTweet = loadTweet();

// Build the children adjacency (parentId -> [comments]) the way commentsListHTML does,
// so the ranking test exercises the same shape the renderer feeds it.
function buildTree(list: any[]) {
  const byId: Record<string, any> = {};
  for (const c of list) byId[c.id] = c;
  const roots: any[] = [];
  const children: Record<string, any[]> = {};
  for (const c of list) {
    const p = c.reply_to != null && byId[c.reply_to] ? c.reply_to : null;
    if (p == null) roots.push(c);
    else (children[p] || (children[p] = [])).push(c);
  }
  return { roots, children };
}

describe("gzTweet.rankTopLevel", () => {
  test("is exposed on window.gzTweet", () => {
    expect(typeof gzTweet.rankTopLevel).toBe("function");
  });

  test("author-participated > engagement > recency", () => {
    const author = "poster";
    // A (oldest) has 3 nested replies, one BY the post author -> author-participated.
    // B (newest) has 0 replies.
    // C (newer than A, older than B) has 1 reply by a non-author.
    const list = [
      { id: "A", handle: "alice", reply_to: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "A1", handle: "bob", reply_to: "A", created_at: "2026-01-01T01:00:00Z" },
      { id: "A2", handle: "poster", reply_to: "A1", created_at: "2026-01-01T02:00:00Z" },
      { id: "A3", handle: "carol", reply_to: "A2", created_at: "2026-01-01T03:00:00Z" },
      { id: "C", handle: "carol", reply_to: null, created_at: "2026-01-02T00:00:00Z" },
      { id: "C1", handle: "dave", reply_to: "C", created_at: "2026-01-02T01:00:00Z" },
      { id: "B", handle: "erin", reply_to: null, created_at: "2026-01-03T00:00:00Z" },
    ];
    const { roots, children } = buildTree(list);
    const ranked = gzTweet.rankTopLevel(roots, children, author);
    expect(ranked.map((c) => c.id)).toEqual(["A", "C", "B"]);
  });

  test("equal engagement falls back to recency (newer first)", () => {
    const author = "poster";
    // Two zero-reply top-level comments, neither author-participated: newest ranks first.
    const list = [
      { id: "old", handle: "alice", reply_to: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "new", handle: "bob", reply_to: null, created_at: "2026-01-05T00:00:00Z" },
    ];
    const { roots, children } = buildTree(list);
    const ranked = gzTweet.rankTopLevel(roots, children, author);
    expect(ranked.map((c) => c.id)).toEqual(["new", "old"]);
  });

  test("a top-level comment by the post author is NOT boosted by that alone", () => {
    const author = "poster";
    // P: authored by the post author, zero replies.
    // Q: authored by someone else, one reply by a non-author (more engagement) -> ranks above P.
    const list = [
      { id: "P", handle: "poster", reply_to: null, created_at: "2026-01-02T00:00:00Z" },
      { id: "Q", handle: "alice", reply_to: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "Q1", handle: "bob", reply_to: "Q", created_at: "2026-01-01T01:00:00Z" },
    ];
    const { roots, children } = buildTree(list);
    const ranked = gzTweet.rankTopLevel(roots, children, author);
    expect(ranked.map((c) => c.id)).toEqual(["Q", "P"]);
  });

  test("replies inside a subtree stay chronological (rendered order preserved)", () => {
    // rankTopLevel only reorders top-level nodes; the children adjacency it receives is
    // built chronologically (API returns created_at ASC) and is never touched. Assert
    // that the children arrays are still in ascending time order after ranking.
    const author = "poster";
    const list = [
      { id: "A", handle: "alice", reply_to: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "A1", handle: "bob", reply_to: "A", created_at: "2026-01-01T01:00:00Z" },
      { id: "A2", handle: "poster", reply_to: "A", created_at: "2026-01-01T02:00:00Z" },
      { id: "A3", handle: "carol", reply_to: "A", created_at: "2026-01-01T03:00:00Z" },
    ];
    const { roots, children } = buildTree(list);
    gzTweet.rankTopLevel(roots, children, author);
    expect(children["A"].map((c) => c.id)).toEqual(["A1", "A2", "A3"]);
    // And their timestamps are strictly ascending.
    const times = children["A"].map((c) => Date.parse(c.created_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
