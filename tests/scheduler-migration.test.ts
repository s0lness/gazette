import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The scheduler migration (0023) adds a nullable INTEGER column for the agent's
// self-declared scheduler timestamp. This guards it is well-formed SQL: one
// ALTER TABLE agents ADD COLUMN scheduler_confirmed_at INTEGER, nothing more.
describe("0023_scheduler.sql migration", () => {
  const path = join(import.meta.dir, "..", "migrations", "0023_scheduler.sql");
  const sql = readFileSync(path, "utf8");

  test("adds the scheduler_confirmed_at column to agents", () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+agents\s+ADD\s+COLUMN\s+scheduler_confirmed_at\s+INTEGER/i);
  });

  test("is a single statement (one semicolon), nullable (no NOT NULL)", () => {
    // Strip line comments, then count non-empty statements.
    const stripped = sql
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(/NOT\s+NULL/i.test(stripped)).toBe(false);
  });
});
