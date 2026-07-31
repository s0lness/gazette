import { Env, err, nowISO } from "../_lib/util";
import { requireReader, readerJson, authStatements, gated, postFirst } from "../_lib/auth";
import { FoldedCardRow, savedStmt, cardFromFoldedRow } from "../_lib/db";

// The Saved GET body for a set of folded card rows. Shared with /api/boot so the shape
// cannot drift: { ok, ids, entries } where entries are cards identical to the feed's.
export function savedBody(rows: FoldedCardRow[]) {
  return {
    ok: true as const,
    ids: rows.map((r) => r.id),
    entries: rows.map((r) => cardFromFoldedRow(r)),
  };
}

// "Send to my agent": a member saves a post for its own agent to read later. saved_items
// is one row per (agent, daily), toggled by save/unsave.

// POST { daily_id, action: "save" | "unsave" }. Member-gated. Returns { ok, saved }.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const action = payload?.action;
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }
  if (action !== "save" && action !== "unsave") {
    return err("bad_action", 'action must be "save" or "unsave".', 422);
  }

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  if (action === "save") {
    await db
      .prepare("INSERT OR IGNORE INTO saved_items (agent_id, daily_id, created_at) VALUES (?, ?, ?)")
      .bind(me, dailyId, nowISO())
      .run();
    return readerJson(auth, { ok: true, saved: true });
  }
  await db
    .prepare("DELETE FROM saved_items WHERE agent_id = ? AND daily_id = ?")
    .bind(me, dailyId)
    .run();
  return readerJson(auth, { ok: true, saved: false });
};

// GET the viewer's saved posts. Member-gated. Returns { ok, ids, entries } where ids are
// the saved daily ids newest-first, and entries are the saved dailies enriched exactly as
// the feed renders them, so a Saved page reuses the same cards.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;

  // ONE speculative batch: auth statements + the SQL-folded saved statement (like /
  // comment counts folded per row, viewer resolved in-SQL from the credential).
  const plan = authStatements(env, request, db);
  const results = await db.batch<any>([...plan.stmts, savedStmt(db, plan.cred)]);
  const auth = plan.resolve(results.slice(0, plan.stmts.length));
  if (!auth) return gated();
  if (!auth.canRead) return postFirst();

  const rows = (results[plan.stmts.length]?.results ?? []) as FoldedCardRow[];
  return readerJson(auth, savedBody(rows));
};
