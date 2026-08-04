import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasArtifact,
  lintBeat,
  lintNotes,
  repairArtifact,
  unbacktickPaths,
} from "../tools/beat-lint.mjs";
import { appendToPantry, prepareEntry } from "../tools/pantry-add.mjs";
import { hasArtifact as serverHasArtifact } from "../functions/_lib/lint";

// tools/beat-lint.mjs is a hand-copied mirror of functions/_lib/lint.ts so the drip can
// reject a bad beat before spending an API call. These tests pin the mirror to the server.
describe("artifact rule (local mirror of the server lint)", () => {
  // The shared table both implementations must agree on, byte for byte. Positives and
  // negatives together: the mirror is only useful if it accepts and refuses exactly what
  // the server does, so a widening on one side that is not copied to the other fails here.
  const cases = [
    // positives
    "shipped functions/_lib/db.ts today",
    "see https://gazette.sylve.org/about",
    "commit 261ce26 landed",
    "`functions/_lib/db.ts` in backticks",
    "rewrote build.mjs from scratch",
    "index.html now ships the shell",
    "it is live on plan.sylve.org",
    'renamed "index.html" to shell.html',
    "the entry point (src/app.tsx) moved",
    "attached diagram.png to the beat",
    // negatives
    "nothing shipped today, just thinking",
    "path with no extension: functions/_lib/db",
    "e.g. the thing I was building",
    "i.e. the whole feed",
    "reviewed the feed, the profile, etc. and moved on",
    "I shipped it.Then I went to bed",
    "throughput improved by 3.5 percent",
    "cut v1.2 of the reader",
    "I finally understood Next.js",
  ];

  test("agrees with the server implementation on every case", () => {
    for (const text of cases) {
      expect(hasArtifact(text)).toBe(serverHasArtifact(text));
    }
  });

  test("accepts a bare path, a URL and a commit hash", () => {
    expect(hasArtifact("shipped tools/drip.mjs")).toBe(true);
    expect(hasArtifact("see https://gazette.sylve.org/about")).toBe(true);
    expect(hasArtifact("commit 261ce26 landed")).toBe(true);
  });

  test("accepts a bare filename, a bare host, and a backticked path", () => {
    expect(hasArtifact("rewrote build.mjs from scratch")).toBe(true);
    expect(hasArtifact("it is live on plan.sylve.org")).toBe(true);
    expect(hasArtifact("shipped `tools/drip.mjs` today")).toBe(true);
  });

  test("rejects prose with no artifact, however many dots it carries", () => {
    expect(hasArtifact("I thought about the feed a lot")).toBe(false);
    expect(hasArtifact("e.g. the thing I was building")).toBe(false);
    expect(hasArtifact("I shipped it.Then I went to bed")).toBe(false);
    expect(hasArtifact("cut v1.2 of the reader")).toBe(false);
  });
});

describe("repairArtifact", () => {
  test("a backticked path needs no repair any more: the lint accepts it as is", () => {
    const r = repairArtifact({ headline: "shipped", body: "landed `tools/drip.mjs` today" });
    expect(r.repaired).toBe(false);
    expect(r.entry.body).toBe("landed `tools/drip.mjs` today"); // untouched
    expect(lintBeat({ handle: "gazette", ...r.entry }).ok).toBe(true); // and it lints clean
  });

  test("leaves a beat that already has an artifact untouched", () => {
    const entry = { headline: "shipped tools/drip.mjs", body: "and `some/other.ts`" };
    const r = repairArtifact(entry);
    expect(r.repaired).toBe(false);
    expect(r.entry.body).toBe("and `some/other.ts`");
  });

  test("cannot rescue a beat with no artifact at all", () => {
    expect(repairArtifact({ headline: "I thought hard", body: "about things" }).repaired).toBe(false);
  });

  test("unbacktickPaths leaves non-path code spans alone", () => {
    expect(unbacktickPaths("filter `parent_id IS NULL` on `db.ts`")).toBe(
      "filter `parent_id IS NULL` on `db.ts`",
    );
  });
});

describe("lintBeat", () => {
  const good = { handle: "gazette", headline: "I shipped tools/drip.mjs", body: "## Shipped\nit." };

  test("accepts a well-formed beat", () => {
    expect(lintBeat(good).ok).toBe(true);
  });

  test("requires a handle, a headline, and an artifact", () => {
    expect(lintBeat({ ...good, handle: "" }).errors.map((e) => e.code)).toContain("no_handle");
    expect(lintBeat({ ...good, headline: "" }).errors.map((e) => e.code)).toContain(
      "headline_required",
    );
    expect(
      lintBeat({ handle: "gazette", headline: "no artifact here", body: "" }).errors.map(
        (e) => e.code,
      ),
    ).toContain("no_artifact");
  });

  test("an image_id satisfies the artifact rule", () => {
    expect(lintBeat({ handle: "gazette", headline: "look at this", image_id: "abc" }).ok).toBe(true);
  });

  test("rejects a multiline or over-long headline", () => {
    expect(lintBeat({ ...good, headline: "I shipped\ntools/drip.mjs" }).errors.map((e) => e.code)).toContain(
      "headline_multiline",
    );
    expect(
      lintBeat({ ...good, headline: "x".repeat(201) + " tools/drip.mjs" }).errors.map((e) => e.code),
    ).toContain("headline_too_long");
  });

  test("catches a secret or a private path in the body", () => {
    const codes = lintBeat({
      ...good,
      body: "token ghp_" + "a".repeat(24) + " oops",
    }).errors.map((e) => e.code);
    expect(codes).toContain("privacy");
  });
});

describe("lintNotes", () => {
  test("empty notes are fine, a private home path is not", () => {
    expect(lintNotes("").ok).toBe(true);
    expect(lintNotes("ran it from /home/someone/gazette").ok).toBe(false);
  });
});

describe("pantry append", () => {
  test("prepareEntry stamps captured_at and source, and refuses a bad beat", () => {
    const now = new Date("2026-08-03T10:00:00.000Z");
    const { entry } = prepareEntry(
      { handle: "gazette", headline: "I shipped tools/drip.mjs", body: "## Shipped\nit." },
      { now, source: "test" },
    );
    expect(entry!.captured_at).toBe("2026-08-03T10:00:00.000Z");
    expect(entry!.source).toBe("test");

    const bad = prepareEntry({ handle: "gazette", headline: "I thought about it", body: "" });
    expect(bad.entry).toBeUndefined();
    expect(bad.errors!.map((e) => e.code)).toContain("no_artifact");
  });

  test("appendToPantry appends to an existing file and returns the new size", () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-pantry-"));
    const path = join(dir, "pantry.json");

    const first = { handle: "gazette", headline: "one, tools/drip.mjs", body: "" };
    expect(appendToPantry([first], { path })).toBe(1);

    const second = { handle: "gazette", headline: "two, tools/drip.mjs", body: "" };
    expect(appendToPantry([second], { path })).toBe(2);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.map((e: any) => e.headline)).toEqual([first.headline, second.headline]);
  });

  test("a pre-existing pantry is never truncated by a failed parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-pantry-"));
    const path = join(dir, "pantry.json");
    writeFileSync(path, "[]");
    expect(appendToPantry([], { path })).toBe(0);
    expect(readFileSync(path, "utf8").trim()).toBe("[]");
  });
});

// The seeded pantry must stay postable: every entry passes the same lint the drip runs.
describe("drip/pantry.json", () => {
  test("every stored beat would be accepted by the server", () => {
    const pantry = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "drip", "pantry.json"), "utf8"),
    );
    for (const entry of pantry) {
      const beat = lintBeat(entry);
      expect({ headline: entry.headline, errors: beat.errors }).toEqual({
        headline: entry.headline,
        errors: [],
      });
      expect(lintNotes(entry.notes).ok).toBe(true);
      expect(typeof entry.captured_at).toBe("string");
    }
  });
});
