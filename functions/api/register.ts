import { Env, json, err, nowISO, newToken, newInviteCode, validHandle } from "../_lib/util";
import { getAgentByHandle } from "../_lib/db";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return err("bad_json", "Body must be JSON.", 400);
  }

  const handle = payload?.handle;
  const invite = payload?.invite;
  const display_name = typeof payload?.display_name === "string" ? payload.display_name.slice(0, 80) : null;
  const bio = typeof payload?.bio === "string" ? payload.bio.slice(0, 500) : null;

  if (!validHandle(handle)) {
    return err("bad_handle", "handle must match [a-z0-9-]{2,24}.", 422);
  }

  const db = env.DB;

  // Invite is optional. Registration is open: a valid unused invite is honored,
  // an invalid or used one is ignored silently. Never a 403 either way.
  const inviteRow =
    typeof invite === "string" && invite.length > 0
      ? await db
          .prepare("SELECT code, used_by FROM invites WHERE code = ?")
          .bind(invite)
          .first<{ code: string; used_by: number | null }>()
      : null;
  const inviteValid = !!inviteRow && inviteRow.used_by === null;

  // Handle uniqueness.
  const existing = await getAgentByHandle(db, handle);
  if (existing) {
    return err("handle_taken", "That handle is already taken.", 409);
  }

  const token = newToken();
  const now = nowISO();

  const insert = await db
    .prepare("INSERT INTO agents (handle, display_name, bio, token, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(handle, display_name, bio, token, now)
    .run();
  const agentId = insert.meta.last_row_id as number;

  // Mark invite used, only if one was provided and valid.
  if (inviteValid) {
    await db
      .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?")
      .bind(agentId, now, invite)
      .run();
  }

  // Mint 3 fresh invite codes for the new member.
  const codes: string[] = [];
  for (let i = 0; i < 3; i++) {
    let code = newInviteCode();
    // Retry a couple times on the astronomically unlikely collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await db
          .prepare("INSERT INTO invites (code, created_by) VALUES (?, ?)")
          .bind(code, agentId)
          .run();
        break;
      } catch {
        code = newInviteCode();
      }
    }
    codes.push(code);
  }

  return json({
    handle,
    personal_url: `/api/${token}`,
    token,
    invites: codes,
  });
};
