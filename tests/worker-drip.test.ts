import { expect, test, describe } from "bun:test";
import {
  candidatesFromRows,
  buildRun,
  classifyResponse,
  payloadFor,
  todayUTC,
  runDrip,
} from "../worker-drip/index.js";
import { createDripRun } from "../tools/drip-run.mjs";

// worker-drip/ is the drip on Cloudflare: same selection, D1 instead of json files, a cron
// instead of a Windows scheduled task. The scheduled() handler cannot run here, so its pure
// parts are exported and driven directly, and the tick itself runs against a fake D1 + a
// fake fetch. What matters most: it picks the SAME beats the PC drip would, and it can
// never post one twice.

const row = (
  id: number,
  handle: string,
  origin: "pantry" | "queue",
  position: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  handle,
  headline: `${handle} #${id}`,
  body: "## Shipped\nlanded in src/thing.ts",
  notes: null,
  image_id: null,
  origin,
  position,
  state: "queued",
  ...extra,
});

const agent = (handle: string, hoursAgo: number | null, now: number) => ({
  handle,
  token: `tok-${handle}`,
  last_posted_at: hoursAgo === null ? null : new Date(now - hoursAgo * 3600000).toISOString(),
});

const NOW = Date.parse("2026-08-03T12:00:00Z");

describe("candidatesFromRows", () => {
  test("rebuilds the PC drip's flat list: the whole pantry first, then the queue", () => {
    const rows = [row(3, "b", "queue", 1000001), row(1, "a", "pantry", 0), row(2, "d", "pantry", 1)];
    expect(candidatesFromRows(rows).map((c) => [c.entry.handle, c.from])).toEqual([
      ["a", "pantry"],
      ["d", "pantry"],
      ["b", "queue"],
    ]);
  });

  test("ties on position fall back to the row id, so the order is total", () => {
    const rows = [row(9, "a", "queue", 5), row(4, "b", "queue", 5)];
    expect(candidatesFromRows(rows).map((c) => c.entry.headline)).toEqual(["b #4", "a #9"]);
  });

  test("nullable columns become an absent field, not a null one", () => {
    const [c] = candidatesFromRows([row(1, "a", "pantry", 0)]);
    expect(c.entry).not.toHaveProperty("notes");
    expect(c.entry).not.toHaveProperty("image_id");
    const [withNotes] = candidatesFromRows([row(1, "a", "pantry", 0, { notes: "ctx", image_id: "i1" })]);
    expect(withNotes.entry.notes).toBe("ctx");
    expect(withNotes.entry.image_id).toBe("i1");
  });
});

describe("buildRun picks exactly what the PC drip would", () => {
  // The same fixture expressed both ways: as D1 rows, and as the {entry, from} candidates
  // tools/drip.mjs builds from drip/pantry.json + drip/queue.json.
  const rows = [
    row(1, "gazette", "pantry", 0),
    row(2, "plan", "pantry", 1),
    row(3, "local-agent", "queue", 1000000),
    row(4, "ramage", "queue", 1000001),
    row(5, "gazette", "queue", 1000002),
  ];
  const agents = [
    agent("gazette", 1, NOW),
    agent("plan", 3, NOW),
    agent("local-agent", 68, NOW),
    agent("ramage", 40, NOW),
  ];

  const fileCandidates = [
    { entry: { handle: "gazette", headline: "gazette #1" }, from: "pantry" },
    { entry: { handle: "plan", headline: "plan #2" }, from: "pantry" },
    { entry: { handle: "local-agent", headline: "local-agent #3" }, from: "queue" },
    { entry: { handle: "ramage", headline: "ramage #4" }, from: "queue" },
    { entry: { handle: "gazette", headline: "gazette #5" }, from: "queue" },
  ];

  const drain = (run: any) => {
    const out: string[] = [];
    for (const cand of run.picks()) {
      run.countAttempt();
      run.recordPost(cand.entry.handle);
      out.push(cand.entry.headline);
    }
    return out;
  };

  test("same order, same picks, from D1 rows as from the json files", () => {
    const hours = { gazette: 1, plan: 3, "local-agent": 68, ramage: 40 };
    const fromFiles = createDripRun({
      candidates: fileCandidates,
      hoursByHandle: hours,
      hasToken: () => true,
    });
    const { run: fromD1 } = buildRun({ rows, agents, postedToday: [], now: NOW });

    expect(fromD1.ordered.map((c: any) => c.entry.headline)).toEqual(
      fromFiles.ordered.map((c: any) => c.entry.headline),
    );
    expect(fromD1.budget).toBe(fromFiles.budget);
    expect(fromD1.catchup).toBe(fromFiles.catchup);
    expect(drain(fromD1)).toEqual(drain(fromFiles));
  });

  test("the two at-risk handles get the burst, the fresh ones do not", () => {
    const { run } = buildRun({ rows, agents, postedToday: [], now: NOW });
    expect(run.catchup).toBe(true);
    expect(drain(run)).toEqual(["local-agent #3", "ramage #4"]);
  });

  test("a handle that already posted today is skipped", () => {
    const { run } = buildRun({ rows, agents, postedToday: ["local-agent"], now: NOW });
    expect(drain(run)).toEqual(["ramage #4"]);
  });

  test("an agent with no token in D1 cannot be posted for", () => {
    const skipped: string[] = [];
    const { run, tokens } = buildRun({
      rows,
      agents: agents.filter((a) => a.handle !== "local-agent"),
      postedToday: [],
      now: NOW,
      log: (line: string) => skipped.push(line),
    });
    expect(tokens.has("local-agent")).toBe(false);
    expect(drain(run)).toEqual(["ramage #4"]);
    expect(skipped.join("\n")).toContain("no token for handle 'local-agent'");
  });

  test("an agent that never posted is the most urgent of all", () => {
    const { run, hoursByHandle } = buildRun({
      rows,
      agents: [...agents, agent("ghost", null, NOW)],
      postedToday: [],
      now: NOW,
    });
    expect(hoursByHandle.get("ghost")).toBe(Infinity);
    expect(run.eligible[0]).toBe("local-agent"); // @ghost has no queued beat to post
  });
});

describe("classifyResponse", () => {
  test("maps every response class the site can answer with", () => {
    expect(classifyResponse(200, { ok: true, id: 7 })).toBe("posted");
    expect(classifyResponse(200, { ok: false })).toBe("transient");
    expect(classifyResponse(422, { errors: [] })).toBe("park");
    expect(classifyResponse(429, { code: "daily_cap" })).toBe("handle");
    expect(classifyResponse(404, {})).toBe("handle");
    expect(classifyResponse(403, {})).toBe("handle");
    expect(classifyResponse(500, {})).toBe("transient");
    expect(classifyResponse(502, {})).toBe("transient");
  });
});

describe("payloadFor", () => {
  test("sends headline + body, and the image when there is one", () => {
    expect(payloadFor({ handle: "a", headline: "h", body: "b" })).toEqual({ headline: "h", body: "b" });
    expect(payloadFor({ handle: "a", headline: "h", body: "b", image_id: "i" })).toHaveProperty("image_id", "i");
  });

  test("carries clean notes and DROPS notes that would reject the whole post", () => {
    expect(payloadFor({ handle: "a", headline: "h", body: "b", notes: "just context" }).notes).toBe(
      "just context",
    );
    const logs: string[] = [];
    const payload = payloadFor(
      { handle: "a", headline: "h", body: "b", notes: "reach me at someone@example.com" },
      (l: string) => logs.push(l),
    );
    expect(payload).not.toHaveProperty("notes");
    expect(logs.join("")).toContain("notes dropped");
  });

  test("never passes a legacy project field through", () => {
    expect(payloadFor({ handle: "a", headline: "h", body: "b", project: "old" } as any)).not.toHaveProperty(
      "project",
    );
  });
});

// ---- the tick, against a fake D1 and a fake fetch --------------------------

function fakeDB(opts: { agents: any[]; rows: any[]; postedToday: string[] }) {
  const rows = opts.rows.map((r) => ({ ...r, posted_at: null, daily_id: null, error: null }));
  const find = (id: number) => rows.find((r) => r.id === id)!;
  const exec = (sql: string, binds: any[]) => {
    if (sql.includes("FROM agents")) return { results: opts.agents };
    if (sql.includes("FROM drip_queue")) return { results: rows.filter((r) => r.state === "queued") };
    if (sql.includes("FROM dailies")) return { results: opts.postedToday.map((handle) => ({ handle })) };
    if (sql.includes("SET state = 'posted'")) {
      const target = find(binds[1]);
      if (target.state !== "queued") return { meta: { changes: 0 } };
      target.state = "posted";
      target.posted_at = binds[0];
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET state = 'parked'")) {
      const target = find(binds[1]);
      target.state = "parked";
      target.posted_at = null;
      target.error = binds[0];
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET state = 'queued'")) {
      const target = find(binds[0]);
      if (target.state !== "posted") return { meta: { changes: 0 } };
      target.state = "queued";
      target.posted_at = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET daily_id")) {
      const target = find(binds[2]);
      target.daily_id = binds[0];
      target.posted_at = binds[1];
      return { meta: { changes: 1 } };
    }
    throw new Error("fake D1: unhandled sql " + sql);
  };
  const prepare = (sql: string) => {
    let binds: any[] = [];
    const stmt: any = {
      bind: (...a: any[]) => {
        binds = a;
        return stmt;
      },
      run: async () => exec(sql, binds),
      all: async () => exec(sql, binds),
    };
    return stmt;
  };
  return {
    rows,
    db: { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) },
  };
}

const okResponse = (id: number) => ({
  status: 200,
  json: async () => ({ ok: true, id, date: "2026-08-03", streak: 3 }),
});

describe("runDrip", () => {
  const agents = [agent("late", 40, NOW), agent("later", 50, NOW), agent("fresh", 1, NOW)];

  test("posts through the public API and records the created beat", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "fresh", "pantry", 0), row(2, "late", "queue", 1000000)],
      postedToday: [],
    });
    const calls: any[] = [];
    const res = await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async (url: string, init: any) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return okResponse(42) as any;
        },
      },
    );
    expect(res.posted).toBe(1);
    expect(calls).toHaveLength(1);
    // The site's NORMAL endpoint, with the token read out of the agents table.
    expect(calls[0].url).toBe("https://gazette.sylve.org/api/tok-late/daily");
    expect(calls[0].body).toEqual({ headline: "late #2", body: "## Shipped\nlanded in src/thing.ts" });
    expect(rows.find((r) => r.id === 2)).toMatchObject({ state: "posted", daily_id: 42 });
    expect(rows.find((r) => r.id === 1)!.state).toBe("queued"); // @fresh is not at risk
  });

  test("claims a row BEFORE the request, so a beat cannot go out twice", async () => {
    const { db, rows } = fakeDB({ agents, rows: [row(1, "late", "queue", 0)], postedToday: [] });
    let stateDuringRequest = "";
    await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async () => {
          stateDuringRequest = rows[0].state; // already claimed while the POST is in flight
          return okResponse(1) as any;
        },
      },
    );
    expect(stateDuringRequest).toBe("posted");
  });

  test("a 422 parks the beat with its errors and the run moves on", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0), row(2, "late", "queue", 1)],
      postedToday: [],
    });
    const res = await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async (url: string) =>
          (url.includes("tok-later")
            ? { status: 422, json: async () => ({ ok: false, errors: [{ code: "no_artifact", message: "nope" }] }) }
            : okResponse(9)) as any,
      },
    );
    expect(rows[0]).toMatchObject({ state: "parked" });
    expect(rows[0].error).toContain("no_artifact");
    expect(rows[1].state).toBe("posted"); // the rejection did not burn the run
    expect(res.posted).toBe(1);
    expect(res.parked).toBe(1);
  });

  test("a 429 daily cap keeps the beat queued and sits that handle out", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0), row(2, "later", "queue", 1), row(3, "late", "queue", 2)],
      postedToday: [],
    });
    const seen: string[] = [];
    await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async (url: string) => {
          seen.push(url);
          return (url.includes("tok-later")
            ? { status: 429, json: async () => ({ ok: false, code: "daily_cap" }) }
            : okResponse(5)) as any;
        },
      },
    );
    expect(rows[0].state).toBe("queued"); // released, not parked
    expect(rows[0].posted_at).toBeNull();
    expect(seen.filter((u) => u.includes("tok-later"))).toHaveLength(1); // second @later beat skipped
    expect(rows[2].state).toBe("posted");
  });

  test("a 5xx leaves the beat queued and the next candidate is tried", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0), row(2, "late", "queue", 1)],
      postedToday: [],
    });
    await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async (url: string) =>
          (url.includes("tok-later") ? { status: 503, json: async () => ({}) } : okResponse(6)) as any,
      },
    );
    expect(rows[0].state).toBe("queued");
    expect(rows[1].state).toBe("posted");
  });

  test("a network failure releases the beat and aborts the run", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0), row(2, "late", "queue", 1)],
      postedToday: [],
    });
    const res = await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async () => {
          throw new Error("connection reset");
        },
      },
    );
    expect(res.posted).toBe(0);
    expect(rows.every((r) => r.state === "queued")).toBe(true);
  });

  test("a beat the local lint refuses is parked without spending a request", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0, { body: "no artifact anywhere here" })],
      postedToday: [],
    });
    let calls = 0;
    const res = await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async () => {
          calls++;
          return okResponse(1) as any;
        },
      },
    );
    expect(calls).toBe(0);
    expect(rows[0].state).toBe("parked");
    expect(rows[0].error).toContain("no_artifact");
    expect(res.posted).toBe(0);
  });

  test("a backticked path posts as written (the artifact rule now matches inside backticks)", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0, { body: "## Shipped\nlanded in `src/thing.ts`" })],
      postedToday: [],
    });
    let sent: any = null;
    await runDrip(
      { DB: db },
      {
        now: NOW,
        log: () => {},
        fetchImpl: async (_u: string, init: any) => {
          sent = JSON.parse(init.body);
          return okResponse(3) as any;
        },
      },
    );
    expect(sent.body).toContain("src/thing.ts");
    // The beat is no longer rewritten to get past the lint: the author's markdown ships
    // verbatim, backticks included, and the post still goes out.
    expect(sent.body).toBe("## Shipped\nlanded in `src/thing.ts`");
    expect(rows[0].state).toBe("posted");
  });

  test("an empty queue costs one read and nothing else", async () => {
    const { db } = fakeDB({ agents, rows: [], postedToday: [] });
    let calls = 0;
    const res = await runDrip(
      { DB: db },
      { now: NOW, log: () => {}, fetchImpl: async () => ((calls++), okResponse(1) as any) },
    );
    expect(res).toEqual({ posted: 0, attempts: 0, parked: 0 });
    expect(calls).toBe(0);
  });

  test("handles that already posted today are excluded from the run", async () => {
    const { db, rows } = fakeDB({
      agents,
      rows: [row(1, "later", "queue", 0), row(2, "late", "queue", 1)],
      postedToday: ["later"],
    });
    await runDrip({ DB: db }, { now: NOW, log: () => {}, fetchImpl: async () => okResponse(8) as any });
    expect(rows[0].state).toBe("queued");
    expect(rows[1].state).toBe("posted");
  });
});

describe("todayUTC", () => {
  test("is the UTC day the dailies table is keyed on", () => {
    expect(todayUTC(Date.parse("2026-08-03T23:59:59Z"))).toBe("2026-08-03");
    expect(todayUTC(Date.parse("2026-08-04T00:00:01Z"))).toBe("2026-08-04");
  });
});
