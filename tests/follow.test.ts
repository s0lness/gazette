import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { REACTION_KINDS } from "../functions/_lib/db";
import { followStats } from "../functions/_lib/db";

// The like allowlist: only "like" is a valid reaction kind now (the 3-reaction bar
// is gone). react.ts validates against REACTION_KINDS.
describe("REACTION_KINDS", () => {
  test('is exactly ["like"]', () => {
    expect([...REACTION_KINDS]).toEqual(["like"]);
  });
  test("rejects the old ship/fire/eyes kinds", () => {
    const allowed = REACTION_KINDS as readonly string[];
    expect(allowed.includes("ship")).toBe(false);
    expect(allowed.includes("fire")).toBe(false);
    expect(allowed.includes("eyes")).toBe(false);
  });
});

// A tiny D1-shaped shim over bun:sqlite so we can exercise the real follow SQL
// (followStats + the insert/delete toggle) without a live D1 binding.
function d1(db: Database): any {
  return {
    prepare(sql: string) {
      let args: any[] = [];
      const api: any = {
        bind(...a: any[]) { args = a; return api; },
        async first<T>() { return (db.query(sql).get(...args) as T) ?? null; },
        async all<T>() { return { results: db.query(sql).all(...args) as T[] }; },
        async run() {
          const info = db.query(sql).run(...args);
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  };
}

let sqlite: Database;
let db: any;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.run(
    `CREATE TABLE follows (follower_id INTEGER NOT NULL, followed_id INTEGER NOT NULL,
       created_at TEXT NOT NULL, UNIQUE(follower_id, followed_id));`,
  );
  db = d1(sqlite);
});

// Mirror the toggle in functions/api/follow.ts: insert if not following, delete if
// already following.
async function toggle(followerId: number, followedId: number) {
  const existing = await db
    .prepare("SELECT rowid FROM follows WHERE follower_id = ? AND followed_id = ?")
    .bind(followerId, followedId)
    .first();
  if (existing) {
    await db
      .prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?")
      .bind(followerId, followedId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)")
      .bind(followerId, followedId, "2026-01-01T00:00:00Z")
      .run();
  }
}

describe("follow toggle + followStats", () => {
  test("first toggle follows, second unfollows", async () => {
    // agent 1 follows agent 2
    await toggle(1, 2);
    let s = await followStats(db, 2, 1);
    expect(s.followers_count).toBe(1);
    expect(s.following).toBe(true);
    // agent 2's own following_count is still 0
    expect(s.following_count).toBe(0);

    // toggle again -> unfollow
    await toggle(1, 2);
    s = await followStats(db, 2, 1);
    expect(s.followers_count).toBe(0);
    expect(s.following).toBe(false);
  });

  test("counts distinguish followers from following", async () => {
    await toggle(1, 2); // 1 -> 2
    await toggle(3, 2); // 3 -> 2
    await toggle(2, 4); // 2 -> 4

    // From agent 2's perspective, viewed by agent 1:
    const s = await followStats(db, 2, 1);
    expect(s.followers_count).toBe(2); // 1 and 3 follow 2
    expect(s.following_count).toBe(1); // 2 follows 4
    expect(s.following).toBe(true); // viewer 1 follows 2
  });

  test("viewer who does not follow sees following=false", async () => {
    await toggle(1, 2);
    const s = await followStats(db, 2, 9); // viewer 9 follows no one
    expect(s.followers_count).toBe(1);
    expect(s.following).toBe(false);
  });
});
