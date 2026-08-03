import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

// The flat thread (the Twitter way): a reply is a full tweet card, threads NEVER indent,
// and every reply links to ITS OWN permalink. flattenThread + commentsListHTML +
// replyCardHTML live in the browser file public/tweet.js (attached to window.gzTweet), so
// we load the real shipped source, stub a minimal window/document, evaluate the IIFE, and
// exercise the same helpers the app runs.
function loadTweet(): any {
  const src = readFileSync(new URL("../public/tweet.js", import.meta.url), "utf8");
  const win: any = {
    // gz.js normally provides these; the stubs keep the renderers pure and inspectable.
    gzTime: (iso: string) => `<span class="reltime" data-ts="${iso}">now</span>`,
  };
  const doc: any = { addEventListener: () => {}, createElement: () => ({}) };
  const fn = new Function("window", "document", src);
  fn(win, doc);
  return win.gzTweet;
}

const gzTweet = loadTweet();

// A post by @poster with: two top-level replies (A, C), a reply to a reply (A1 -> A),
// a reply to THAT reply (A2 -> A1, three levels deep), and an auto answer on C.
const THREAD = [
  { id: 10, handle: "alice", body: "top level one", created_at: "2026-07-30T01:00:00Z", kind: null, reply_to: null },
  { id: 11, handle: "bob", body: "answering alice", created_at: "2026-07-30T02:00:00Z", kind: null, reply_to: 10 },
  { id: 12, handle: "carol", body: "top level two", created_at: "2026-07-30T03:00:00Z", kind: null, reply_to: null },
  { id: 13, handle: "poster", body: "answering bob", created_at: "2026-07-30T04:00:00Z", kind: null, reply_to: 11 },
  { id: 14, handle: "poster", body: "auto answer", created_at: "2026-07-30T05:00:00Z", kind: "oracle", reply_to: 12 },
];

describe("gzTweet.flattenThread", () => {
  test("is exposed alongside the other card helpers", () => {
    expect(typeof gzTweet.flattenThread).toBe("function");
    expect(typeof gzTweet.commentsListHTML).toBe("function");
    expect(typeof gzTweet.replyCardHTML).toBe("function");
  });

  test("a conversation's descendants follow their root, at ONE level, chronologically", () => {
    const order = gzTweet.flattenThread(THREAD, "poster").map((c: any) => c.id);
    // Root 10 leads (the post author replied inside it -> author-participated), then its
    // whole conversation in time order (11 then 13, three levels deep flattened to one),
    // then the next root and its own descendant.
    expect(order).toEqual([10, 11, 13, 12, 14]);
  });

  test("ranking is preserved across roots (engagement, then recency)", () => {
    // Two roots, neither author-participated: the one with more descendants ranks first
    // even though it is older, and its descendants still trail it immediately.
    const list = [
      { id: 1, handle: "alice", body: "old but busy", created_at: "2026-07-01T00:00:00Z", reply_to: null },
      { id: 2, handle: "bob", body: "r", created_at: "2026-07-01T01:00:00Z", reply_to: 1 },
      { id: 3, handle: "carol", body: "r2", created_at: "2026-07-01T02:00:00Z", reply_to: 2 },
      { id: 4, handle: "dave", body: "new and quiet", created_at: "2026-07-05T00:00:00Z", reply_to: null },
    ];
    expect(gzTweet.flattenThread(list, "poster").map((c: any) => c.id)).toEqual([1, 2, 3, 4]);
  });

  test("a reply whose target is not loaded starts its own run", () => {
    const list = [
      { id: 9, handle: "alice", body: "orphan reply", created_at: "2026-07-30T01:00:00Z", reply_to: 999 },
    ];
    expect(gzTweet.flattenThread(list, "poster").map((c: any) => c.id)).toEqual([9]);
  });
});

describe("commentsListHTML renders a FLAT run of full tweet cards", () => {
  const html: string = gzTweet.commentsListHTML(THREAD, "poster", { root: 5 });

  test("no nesting: the old indent ladder is gone", () => {
    expect(html).not.toContain("tw-c-children");
    expect(html).not.toContain("tw-c-nested");
    // Every card is a sibling article, none is inside another.
    expect(html.split("<article").length - 1).toBe(THREAD.length);
    expect(html.split("</article>").length - 1).toBe(THREAD.length);
    // The cards close before the next one opens (a flat list, not a tree).
    const opens = [...html.matchAll(/<article/g)].map((m) => m.index!);
    const closes = [...html.matchAll(/<\/article>/g)].map((m) => m.index!);
    for (let i = 0; i < opens.length - 1; i++) expect(closes[i]).toBeLessThan(opens[i + 1]);
  });

  test("a reply is a full tweet card: same anatomy as a post card", () => {
    // Same article class, avatar, bold name, muted handle, body, and the SAME action row
    // (reply, like, bookmark, share) a post card renders.
    expect(html).toContain('class="tweet tw-c');
    expect(html).toContain("tw-avatar-link");
    expect(html).toContain('class="tw-who"');
    expect(html).toContain('class="tw-handle"');
    expect(html).toContain('class="tw-actions"');
    expect(html).toContain("tw-comment-btn");
    expect(html).toContain("tw-like-btn");
    expect(html).toContain("tw-bookmark-btn");
    expect(html).toContain("tw-share-btn");
  });

  test("a reply to a reply carries the 'replying to @who' context line", () => {
    // 11 answers alice (10), 13 answers bob (11), 14 answers carol (12).
    expect(html).toContain('class="tw-c-replying">replying to <a href="/a/alice">@alice</a>');
    expect(html).toContain('class="tw-c-replying">replying to <a href="/a/bob">@bob</a>');
    // A direct reply to the post gets no context line: it is implicit. Two roots here,
    // three answers -> exactly three context lines.
    expect(html.split("tw-c-replying").length - 1).toBe(3);
  });

  test("the auto chip survives for an auto-written answer", () => {
    expect(html).toContain('class="cm-oracle"');
    expect(html).toContain(">auto</span>");
  });

  test("conversation grouping is visual only: continuation flags, never an indent", () => {
    // The three continuation cards (11, 13, 14) are flagged; the two roots are not.
    expect(html.split("tw-c-cont").length - 1).toBe(3);
    expect(html).not.toContain("margin-left");
    expect(html).not.toContain("padding-left");
  });
});

describe("every tweet is permalinkable", () => {
  test("a reply's permalink uses the REPLY author's handle, never the post author's", () => {
    const c = { id: 1000042, handle: "bob", body: "hi", created_at: "2026-07-30T02:00:00Z", reply_to: null };
    // Rendered inside @poster's thread: the post author must NOT leak into the URL.
    const card: string = gzTweet.replyCardHTML(c, null, { root: 5 });
    expect(card).toContain('class="tw-when" href="/a/bob/status/1000042"');
    expect(card).not.toContain("/a/poster/status/");
    // The share/copy-link action targets the same pair (handle + id of the REPLY).
    expect(card).toContain('data-handle="bob"');
    expect(card).toContain('data-id="1000042"');
    // And the helper itself pairs a handle with an id.
    expect(gzTweet.permalink("bob", 1000042)).toBe("/a/bob/status/1000042");
  });

  test("each card in a thread links to its own author's permalink", () => {
    const html: string = gzTweet.commentsListHTML(THREAD, "poster");
    for (const c of THREAD) {
      expect(html).toContain(`class="tw-when" href="/a/${c.handle}/status/${c.id}"`);
    }
  });
});

describe("gzTweet.descendantsOf", () => {
  test("collects a focused tweet's whole sub-conversation from the flat list", () => {
    expect(gzTweet.descendantsOf(THREAD, 10).map((c: any) => c.id)).toEqual([11, 13]);
    expect(gzTweet.descendantsOf(THREAD, 11).map((c: any) => c.id)).toEqual([13]);
    expect(gzTweet.descendantsOf(THREAD, 13)).toEqual([]);
  });
});
