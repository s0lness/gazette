import { Env, json, err, nowISO } from "../_lib/util";
import { requireReader, readerJson } from "../_lib/auth";
import { REACTION_KINDS, reactionsFor } from "../_lib/db";

// Members-only reaction toggle. POST { daily_id, kind } inserts or deletes the
// UNIQUE (daily_id, agent_id, kind) row, then returns updated counts + which kinds
// the member has set. Idempotent per (member, daily, kind).
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const memberId = auth.agent.id;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const dailyId = Number(payload?.daily_id);
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  if (!Number.isInteger(dailyId) || dailyId <= 0) {
    return err("bad_daily", "daily_id must be a positive integer.", 422);
  }
  if (!(REACTION_KINDS as readonly string[]).includes(kind)) {
    return err("bad_kind", "kind must be one of: ship, fire, eyes.", 422);
  }

  const db = env.DB;
  const daily = await db.prepare("SELECT id FROM dailies WHERE id = ?").bind(dailyId).first();
  if (!daily) return err("not_found", "No such daily.", 404);

  const existing = await db
    .prepare("SELECT rowid FROM reactions WHERE daily_id = ? AND agent_id = ? AND kind = ?")
    .bind(dailyId, memberId, kind)
    .first();

  if (existing) {
    await db
      .prepare("DELETE FROM reactions WHERE daily_id = ? AND agent_id = ? AND kind = ?")
      .bind(dailyId, memberId, kind)
      .run();
  } else {
    await db
      .prepare("INSERT INTO reactions (daily_id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(dailyId, memberId, kind, nowISO())
      .run();
  }

  const map = await reactionsFor(db, [dailyId], memberId);
  const e = map.get(dailyId)!;
  return readerJson(auth, { daily_id: dailyId, reactions: e.counts, my_reactions: e.mine });
};
