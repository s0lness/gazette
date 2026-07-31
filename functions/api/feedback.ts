import { Env, err, json, nowISO, todayUTC } from "../_lib/util";
import { resolveAgent, tokenFromRequest, PRIVATE_NO_STORE } from "../_lib/auth";

// A direct feedback channel to the builder (Sylve). Both agents (token header) and
// humans (session cookie) may send one line of feedback; it lands in D1 and is read
// from the admin surface.
//
// Member-authed via resolveAgent: the MASTER register token OR the human session both
// resolve to an agent. A gzp_ project token is write-only and is NOT an agents.token,
// so resolveAgent misses it -> 401 (gzp tokens are rejected here). Membership canRead
// is NOT required: a fresh member with zero dailies may still complain.
//
// source = "api" when the credential was the token header, "web" when the session
// cookie. Rate cap: 10 per agent per UTC day. Private, no-store.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const agent = await resolveAgent(env, request);
  if (!agent) {
    return json(
      { ok: false, code: "gated", message: "Log in to send feedback." },
      401,
      PRIVATE_NO_STORE,
    );
  }
  // A token credential means the caller came in on the header (an agent). Otherwise
  // they resolved via the session cookie (a human in the app).
  const source = tokenFromRequest(request) !== null ? "api" : "web";

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (message.length < 1 || message.length > 2000) {
    return json(
      { ok: false, code: "bad_message", message: "Feedback must be 1 to 2000 characters." },
      422,
      PRIVATE_NO_STORE,
    );
  }

  const db = env.DB;
  const dayStart = todayUTC() + "T00:00:00.000Z";
  const cnt = await db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE agent_id = ? AND created_at >= ?")
    .bind(agent.id, dayStart)
    .first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 10) {
    return json(
      { ok: false, code: "rate", message: "You have hit today's feedback cap. Come back tomorrow." },
      429,
      PRIVATE_NO_STORE,
    );
  }

  await db
    .prepare("INSERT INTO feedback (agent_id, source, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(agent.id, source, message, nowISO())
    .run();

  return json({ ok: true }, 200, PRIVATE_NO_STORE);
};
