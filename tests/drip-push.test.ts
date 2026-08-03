import { expect, test, describe } from "bun:test";
import { dedupeKey, dedupeInput } from "../tools/drip-dedupe.mjs";
import {
  buildRows,
  partitionRows,
  insertStatements,
  COLUMNS,
  QUEUE_POSITION_BASE,
} from "../tools/drip-push.mjs";

// tools/drip-push.mjs moves the beats waiting on the PC into D1, where the cron Worker can
// drain them. Pushing must be safe to repeat: the SAME files pushed twice must insert
// nothing the second time, and must never resurrect a beat that was already posted or
// parked. That property is the dedupe key plus partitionRows, so both are pinned here.

const beat = (handle: string, headline: string, extra: Record<string, unknown> = {}) => ({
  handle,
  headline,
  body: "## Shipped\nsomething in src/thing.ts",
  ...extra,
});

describe("dedupeKey", () => {
  test("is a stable sha-256 hex over handle + headline", async () => {
    const key = await dedupeKey("gazette", "a headline");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await dedupeKey("gazette", "a headline")).toBe(key);
  });

  test("differs by handle and by headline", async () => {
    const a = await dedupeKey("gazette", "same");
    expect(await dedupeKey("vigil", "same")).not.toBe(a);
    expect(await dedupeKey("gazette", "other")).not.toBe(a);
  });

  test("ignores surrounding whitespace (pantry-add trims what it writes)", async () => {
    expect(await dedupeKey(" gazette ", " a headline ")).toBe(await dedupeKey("gazette", "a headline"));
    expect(dedupeInput("gazette", "x")).toBe("gazette\nx");
  });

  test("the body is NOT part of the identity: editing it does not mint a second beat", async () => {
    // Two pantry entries with the same handle+headline but different bodies are ONE beat.
    const rows = await buildRows({
      pantry: [beat("gazette", "one"), beat("gazette", "one", { body: "rewritten, docs/x.md" })],
    });
    expect(rows).toHaveLength(1);
  });
});

describe("buildRows", () => {
  test("keeps origin and file order, pantry ahead of queue", async () => {
    const rows = await buildRows({
      pantry: [beat("a", "p0"), beat("b", "p1")],
      queue: [beat("d", "q0"), beat("e", "q1")],
    });
    expect(rows.map((r) => [r.headline, r.origin, r.position])).toEqual([
      ["p0", "pantry", 0],
      ["p1", "pantry", 1],
      ["q0", "queue", QUEUE_POSITION_BASE],
      ["q1", "queue", QUEUE_POSITION_BASE + 1],
    ]);
  });

  test("a queue row's position never depends on how big the pantry is", async () => {
    const small = await buildRows({ pantry: [beat("a", "p")], queue: [beat("d", "q")] });
    const big = await buildRows({
      pantry: [beat("a", "p"), beat("a", "p2"), beat("a", "p3")],
      queue: [beat("d", "q")],
    });
    const q = (rows: any[]) => rows.find((r) => r.headline === "q").position;
    expect(q(small)).toBe(q(big)); // appending to the pantry cannot renumber D1 rows
  });

  test("every row starts queued, with the optional fields nulled not undefined", async () => {
    const rows = await buildRows({ pantry: [beat("a", "p")] });
    expect(rows[0].state).toBe("queued");
    expect(rows[0].notes).toBeNull();
    expect(rows[0].image_id).toBeNull();
    expect(rows[0].source).toBeNull();
    expect(rows[0].captured_at).toBeNull();
    for (const col of COLUMNS) expect(rows[0]).toHaveProperty(col);
  });

  test("carries notes, image_id, source and captured_at through", async () => {
    const rows = await buildRows({
      pantry: [
        beat("a", "p", {
          notes: "private context",
          image_id: "img1",
          source: "session",
          captured_at: "2026-08-01T10:00:00Z",
        }),
      ],
    });
    expect(rows[0]).toMatchObject({
      notes: "private context",
      image_id: "img1",
      source: "session",
      captured_at: "2026-08-01T10:00:00Z",
    });
  });

  test("drops what can never be posted (no handle, no headline)", async () => {
    const rows = await buildRows({
      pantry: [beat("", "orphan"), { handle: "a", headline: "  " } as any, beat("a", "real")],
    });
    expect(rows.map((r) => r.headline)).toEqual(["real"]);
  });

  test("the same beat in BOTH files yields one row, the pantry one", async () => {
    const rows = await buildRows({ pantry: [beat("a", "dup")], queue: [beat("a", "dup")] });
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("pantry");
  });
});

describe("partitionRows: the idempotency computation", () => {
  test("a beat already in D1 is not re-inserted, whatever its state", async () => {
    const rows = await buildRows({ pantry: [beat("a", "old"), beat("a", "new")] });
    const already = rows.filter((r) => r.headline === "old").map((r) => r.dedupe_key);
    const { fresh, present } = partitionRows(rows, already);
    expect(fresh.map((r) => r.headline)).toEqual(["new"]);
    expect(present.map((r) => r.headline)).toEqual(["old"]);
  });

  test("pushing the same files twice inserts nothing the second time", async () => {
    const rows = await buildRows({ pantry: [beat("a", "one")], queue: [beat("b", "two")] });
    const inD1 = new Set(partitionRows(rows, []).fresh.map((r) => r.dedupe_key));
    const again = await buildRows({ pantry: [beat("a", "one")], queue: [beat("b", "two")] });
    expect(partitionRows(again, inD1).fresh).toEqual([]);
  });

  test("a posted or parked beat still counts as present (never resurrected)", async () => {
    const rows = await buildRows({ pantry: [beat("a", "posted long ago")] });
    // The push only ever asks "do you know this key", never "is it still queued".
    expect(partitionRows(rows, [rows[0].dedupe_key]).fresh).toEqual([]);
  });
});

describe("insertStatements", () => {
  test("batches rows and binds every column in order", async () => {
    const rows = await buildRows({
      queue: Array.from({ length: 5 }, (_, i) => beat(`h${i}`, `head ${i}`)),
    });
    const stmts = insertStatements(rows, 2);
    expect(stmts).toHaveLength(3); // 2 + 2 + 1
    expect(stmts[0].params).toHaveLength(2 * COLUMNS.length);
    expect(stmts[2].params).toHaveLength(COLUMNS.length);
    expect(stmts[0].sql).toStartWith("INSERT OR IGNORE INTO drip_queue");
    // OR IGNORE: a row inserted by a racing push is skipped, not a failed batch.
    expect(stmts[0].sql.match(/\?/g)).toHaveLength(2 * COLUMNS.length);
    expect(stmts[0].params[0]).toBe("h0");
  });

  test("a batch stays under SQLite's 999 bound-parameter ceiling", async () => {
    const rows = await buildRows({
      queue: Array.from({ length: 400 }, (_, i) => beat(`h${i}`, `head ${i}`)),
    });
    for (const stmt of insertStatements(rows)) expect(stmt.params.length).toBeLessThan(999);
  });

  test("nothing fresh means nothing to send", () => {
    expect(insertStatements([])).toEqual([]);
  });
});
