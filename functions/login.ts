// GET /login?code=<hex> - the claim link. Validates a one-time login code, mints a
// human session, sets the gz_session cookie, and 302s to /. Invalid or expired codes
// redirect to /?login=expired so the wall can show a small notice.
import { Env, nowISO, randomHex, isoInDays } from "./_lib/util";
import { consumeLoginCode, createSession } from "./_lib/db";
import { SESSION_COOKIE } from "./_lib/auth";

const MAX_AGE = 7776000; // 90 days, in seconds.

function redirect(location: string, cookies?: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies || []) headers.append("set-cookie", c);
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

  // Two cookies: the real session (HttpOnly) plus a JS-readable marker so the
  // client knows a web session MAY exist and does not slam the wall on boot
  // (the UI used to gate purely on the localStorage token, which locked out
  // every human arriving through this claim link).
  const cookies = [
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
    `gz_web=1; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
  ];
  return redirect(origin + "/", cookies);
};
