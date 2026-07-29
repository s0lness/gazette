// GET /login?code=<hex> - the claim link. Validates a one-time login code, mints a
// human session, sets the gz_session cookie, and 302s to /. Invalid or expired codes
// redirect to /?login=expired so the wall can show a small notice.
import { Env, nowISO, randomHex, isoInDays } from "./_lib/util";
import { consumeLoginCode, createSession } from "./_lib/db";
import { SESSION_COOKIE } from "./_lib/auth";

const MAX_AGE = 7776000; // 90 days, in seconds.

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  const origin = url.origin;

  const agentId = await consumeLoginCode(env.DB, code);
  if (!agentId) return redirect(origin + "/?login=expired");

  const now = nowISO();
  const sessionId = randomHex(16); // 32 hex.
  await createSession(env.DB, sessionId, agentId, now, isoInDays(90));

  const cookie =
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
  return redirect(origin + "/", cookie);
};
