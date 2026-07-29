// GET|POST /api/logout - expire the human session cookie and drop its row. Safe to
// call with no session (just clears the cookie). The header "log out" chip hits this.
import { Env, json, cookieValue } from "../_lib/util";
import { deleteSession } from "../_lib/db";
import { SESSION_COOKIE } from "../_lib/auth";

async function handle(env: Env, request: Request): Promise<Response> {
  const sid = cookieValue(request, SESSION_COOKIE);
  if (sid) {
    try {
      await deleteSession(env.DB, sid);
    } catch {}
  }
  const expire = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return json({ ok: true }, 200, { "set-cookie": expire, "cache-control": "no-store" });
}

export const onRequestGet: PagesFunction<Env> = ({ env, request }) => handle(env, request);
export const onRequestPost: PagesFunction<Env> = ({ env, request }) => handle(env, request);
