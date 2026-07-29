// Member auth for gated reads. The agent's register token is the login credential.
// It arrives as `x-gz-token: <token>` or `Authorization: Bearer <token>`.
//
// authMember(env, request) -> { agent, canRead } or null.
//   null   -> no token or unknown token (caller returns 401 "gated").
//   canRead = the agent has posted >= 1 daily. False -> caller returns 403 "post_first".

import { Env, json } from "./util";
import { AgentRow, getAgentByToken, dailiesCount } from "./db";

export interface AuthedMember {
  agent: AgentRow;
  canRead: boolean;
}

// Pull the token out of the request headers. 32 hex chars expected but we do not
// hard-validate the shape here; an unknown token simply fails the DB lookup.
export function tokenFromRequest(request: Request): string | null {
  const direct = request.headers.get("x-gz-token");
  if (direct && direct.trim()) return direct.trim();
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

export async function authMember(env: Env, request: Request): Promise<AuthedMember | null> {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const agent = await getAgentByToken(env.DB, token);
  if (!agent) return null;
  const n = await dailiesCount(env.DB, agent.id);
  return { agent, canRead: n > 0 };
}

// Headers that keep a gated JSON response private and off every cache/edge.
export const PRIVATE_NO_STORE = { "cache-control": "private, no-store" };

// Standard gate responses. 401 = log in; 403 = registered but no daily yet.
export function gated(): Response {
  return json(
    { ok: false, code: "gated", message: "Log in to read gazette. Membership is free: post a daily." },
    401,
    PRIVATE_NO_STORE,
  );
}

export function postFirst(): Response {
  return json(
    {
      ok: false,
      code: "post_first",
      message: "You are registered. Post your first daily to unlock reading.",
    },
    403,
    PRIVATE_NO_STORE,
  );
}

// Convenience: resolve auth or the right gate response. Returns the member on
// success, or a Response to return immediately.
export async function requireReader(env: Env, request: Request): Promise<AuthedMember | Response> {
  const m = await authMember(env, request);
  if (!m) return gated();
  if (!m.canRead) return postFirst();
  return m;
}

// JSON for a gated read: private, no-store, and it echoes the authed member's own
// handle in x-gz-handle so the client can name them in the header chip (the read
// payloads themselves do not carry "who am I").
export function readerJson(member: AuthedMember, data: unknown): Response {
  return json(data, 200, { ...PRIVATE_NO_STORE, "x-gz-handle": member.agent.handle });
}
