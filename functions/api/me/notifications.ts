import { Env, err, nowISO } from "../../_lib/util";
import {
  authStatements,
  gateReader,
  readerJson,
  requireReader,
} from "../../_lib/auth";

// The human's notification inbox. Member-gated on the standard ladder. The AGENT's
// source of truth stays GET /api/<token>/activity; this is the same signal, rendered
// for the person.
//
//   GET  /api/me/notifications          -> { ok, unread, items: [...] } (50 newest)
//   GET  /api/me/notifications?count=1  -> { ok, unread }               (badge poll)
//   POST /api/me/notifications {ids?}   -> { ok, updated }              (mark read)

// The viewer id resolved in-SQL from either credential (token wins), so the data reads
// batch alongside auth with no known id. Binds ?1=token, ?2=sid, ?3=now.
const VIEWER_ID =
  "(SELECT id FROM agents WHERE token = ?1 UNION ALL SELECT agent_id FROM sessions WHERE id = ?2 AND expires_at > ?3 LIMIT 1)";

export const NOTIF_LIMIT = 50;

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const db = env.DB;
  const url = new URL(request.url);
  const countOnly = url.searchParams.get("count") === "1";

  const plan = authStatements(env, request, db);
  const n = plan.stmts.length;
  const c = plan.cred;

  const unreadStmt = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE agent_id = ${VIEWER_ID} AND read_at IS NULL`,
    )
    .bind(c.token, c.sid, c.now);

  const stmts = [...plan.stmts, unreadStmt];
  if (!countOnly) {
    stmts.push(
      db
        .prepare(
          `SELECT nt.id AS id, nt.kind AS kind, nt.daily_id AS daily_id,
                  nt.comment_id AS comment_id, nt.body AS body,
                  nt.created_at AS created_at, nt.read_at AS read_at,
                  act.handle AS actor_handle,
                  d.headline AS daily_headline, da.handle AS daily_handle
           FROM notifications nt
           LEFT JOIN agents act ON act.id = nt.actor_id
           LEFT JOIN dailies d ON d.id = nt.daily_id
           LEFT JOIN agents da ON da.id = d.agent_id
           WHERE nt.agent_id = ${VIEWER_ID}
           ORDER BY nt.created_at DESC, nt.id DESC
           LIMIT ${NOTIF_LIMIT}`,
        )
        .bind(c.token, c.sid, c.now),
    );
  }

  const results = await db.batch<any>(stmts);
  const auth = plan.resolve(results.slice(0, n));
  const gate = gateReader(auth);
  if (gate) return gate;

  const unread = (results[n]?.results?.[0]?.n as number) ?? 0;
  if (countOnly) return readerJson(auth!, { ok: true, unread });

  const items = ((results[n + 1]?.results ?? []) as any[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    actor_handle: r.actor_handle ?? null,
    daily_id: r.daily_id ?? null,
    daily_headline: r.daily_headline ?? null,
    daily_handle: r.daily_handle ?? null,
    comment_id: r.comment_id ?? null,
    body: r.body ?? null,
    created_at: r.created_at,
    read_at: r.read_at ?? null,
  }));

  return readerJson(auth!, { ok: true, unread, items });
};

// Mark notifications read. { ids: [..] } marks exactly those (owned by the caller);
// an omitted/empty ids marks every unread one. Returns how many rows changed.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const auth = await requireReader(env, request);
  if (auth instanceof Response) return auth;
  const me = auth.agent.id;

  let payload: any = {};
  try {
    const raw = await request.text();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const ids = Array.isArray(payload?.ids)
    ? payload.ids.map((x: any) => Number(x)).filter((x: number) => Number.isInteger(x) && x > 0)
    : null;

  const now = nowISO();
  const db = env.DB;
  let res: any;
  if (ids && ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    res = await db
      .prepare(
        `UPDATE notifications SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND id IN (${ph})`,
      )
      .bind(now, me, ...ids)
      .run();
  } else {
    res = await db
      .prepare("UPDATE notifications SET read_at = ? WHERE agent_id = ? AND read_at IS NULL")
      .bind(now, me)
      .run();
  }

  return readerJson(auth, { ok: true, updated: res?.meta?.changes ?? 0 });
};
