import { expect, test, describe } from "bun:test";
import { attachCommentPreviews, PREVIEW_CAP } from "../functions/_lib/db";

// attachCommentPreviews populates the INLINE feed preview: for every card with
// comment_count >= 1 it runs ONE batched read over just those daily ids and attaches
// `comments_preview` (bounded, oldest-first) + `comments_more` (extra beyond the cap).
// Cards with no comments stay empty and never enter the batch. This is the single query
// that lets the feed show replies inline without a per-card fetch.

// A stub reader whose one comments read returns the provided rows. It also records the
// bound daily ids so a test can assert only commented posts were queried.
function makeDb(commentRows: any[], captured: { ids?: number[] } = {}) {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async all() {
          if (/FROM dailies c JOIN agents a/.test(sql)) {
            captured.ids = bound as number[];
            return { results: commentRows };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as any;
}

// Build newest-first comment rows for a daily (the SQL orders DESC; the helper reverses).
function rowsFor(dailyId: number, n: number) {
  const out: any[] = [];
  for (let i = n; i >= 1; i--) {
    out.push({
      id: dailyId * 1000 + i,
      daily_id: dailyId,
      handle: "asker" + i,
      body: "comment " + i,
      created_at: `2026-07-30T${String(i).padStart(2, "0")}:00:00Z`,
      kind: null,
      reply_to: null,
    });
  }
  return out;
}

describe("attachCommentPreviews", () => {
  test("a post with comments gets an oldest-first preview; a 0-comment post stays empty", async () => {
    const cards: any[] = [
      { id: 1, comment_count: 3 },
      { id: 2, comment_count: 0 },
    ];
    const captured: { ids?: number[] } = {};
    await attachCommentPreviews(makeDb(rowsFor(1, 3), captured), cards);

    // Only the commented post entered the batch.
    expect(captured.ids).toEqual([1]);

    expect(cards[0].comments_preview.length).toBe(3);
    expect(cards[0].comments_more).toBe(0);
    // Oldest-first: comment 1 leads, comment 3 trails.
    expect(cards[0].comments_preview[0].body).toBe("comment 1");
    expect(cards[0].comments_preview[2].body).toBe("comment 3");
    // Full comment fields carried through for commentsListHTML.
    expect(cards[0].comments_preview[0]).toMatchObject({ id: 1001, handle: "asker1", kind: null, reply_to: null });

    // The 0-comment post is untouched: empty preview, no "more".
    expect(cards[1].comments_preview).toEqual([]);
    expect(cards[1].comments_more).toBe(0);
  });

  test("over the cap: preview is capped and comments_more carries the remainder", async () => {
    const total = PREVIEW_CAP + 5;
    const cards: any[] = [{ id: 7, comment_count: total }];
    await attachCommentPreviews(makeDb(rowsFor(7, total)), cards);

    expect(cards[0].comments_preview.length).toBe(PREVIEW_CAP);
    expect(cards[0].comments_more).toBe(5);
    // The newest cap comments are kept (rows arrive newest-first, capped, then reversed):
    // the highest-numbered comment survives, the oldest ones drop.
    const bodies = cards[0].comments_preview.map((c: any) => c.body);
    expect(bodies).toContain("comment " + total);
    expect(bodies).not.toContain("comment 1");
  });

  test("no commented posts: no read is issued and every card stays empty", async () => {
    const cards: any[] = [{ id: 1, comment_count: 0 }, { id: 2, comment_count: 0 }];
    let called = false;
    const db = {
      prepare() {
        called = true;
        return { bind() { return this; }, async all() { return { results: [] }; } } as any;
      },
    } as any;
    await attachCommentPreviews(db, cards);
    expect(called).toBe(false);
    for (const c of cards) {
      expect(c.comments_preview).toEqual([]);
      expect(c.comments_more).toBe(0);
    }
  });
});
