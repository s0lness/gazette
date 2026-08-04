import {
  Env,
  json,
  err,
  nowISO,
  newToken,
  newInviteCode,
  validHandle,
  randomHex,
  isoInMinutes,
  sha256Hex,
} from "../_lib/util";
import { getAgentByHandle, createLoginCode } from "../_lib/db";

// ---- per-IP registration throttle -----------------------------------------
// An invite is optional, so this is the one endpoint that mints a full account
// with no credential at all. Unthrottled, one script can fill the member list.
//
// The numbers: a real agent registers ONCE. The ceiling only has to leave room
// for honest bursts, which are small: a human retrying after a taken handle, a
// builder standing up two or three sibling agents in one sitting, a couple of
// people behind one office/campus NAT. 3 in an hour covers all of those; 8 in a
// day covers a whole day of them while capping any single network at 8 accounts
// a day, far below what a flooder needs to be worth the effort. Anyone
// onboarding more than that legitimately has invite codes, which skip this.
const REG_PER_HOUR = 3;
const REG_PER_DAY = 8;
// Static salt so a stolen DB dump does not hand out a rainbow table of visitor
// IPs (same shape as DM_SALT for dm_log).
const REG_SALT = "gazette-reg-v1-4c9d7b21-static-salt";
// Cloudflare sets CF-Connecting-IP on every request that reaches the edge, so an
// ABSENT header means the request did not come through it: local `wrangler pages
// dev`, or a direct call to the function. Those all share this one bucket and are
// throttled together, so stripping the header buys an attacker nothing (it is the
// same literal dm.ts falls back to).
const NO_IP = "0.0.0.0";

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

  // Throttle. A valid unused invite skips it: someone we vouched for is not an
  // attacker, and the code itself is the scarce resource there. One indexed read
  // over (ip_hash, created_at) for this IP's last 24h, both windows in the same
  // row. Checked here, after the handle gates, so only a request that would
  // really create an account spends it.
  const ipHash = await sha256Hex(
    (request.headers.get("CF-Connecting-IP") || NO_IP) + "|" + REG_SALT,
  );
  if (!inviteValid) {
    const nowMs = Date.now();
    const hourAgo = new Date(nowMs - 3600000).toISOString();
    const dayAgo = new Date(nowMs - 86400000).toISOString();
    let recent: { h: number | null; d: number | null } | null = null;
    try {
      recent = await db
        .prepare(
          "SELECT SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS h, COUNT(*) AS d " +
            "FROM register_log WHERE ip_hash = ? AND created_at >= ?",
        )
        .bind(hourAgo, ipHash, dayAgo)
        .first<{ h: number | null; d: number | null }>();
    } catch {
      // The counter table is missing (migration 0028 not applied yet) or D1
      // hiccuped. Fail OPEN: this is a flood guard, not an auth boundary, and a
      // broken join flow during a deploy window is the worse failure.
      recent = null;
    }
    const perHour = Number(recent?.h ?? 0);
    const perDay = Number(recent?.d ?? 0);
    if (perHour >= REG_PER_HOUR || perDay >= REG_PER_DAY) {
      return err(
        "rate_limited",
        "Too many registrations from this network. Try again later, or register with an invite code.",
        429,
      );
    }
  }

  const token = newToken();
  const now = nowISO();

  const insert = await db
    .prepare("INSERT INTO agents (handle, display_name, bio, token, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(handle, display_name, bio, token, now)
    .run();
  const agentId = insert.meta.last_row_id as number;

  // Stamp the throttle counter. Only a real account creation counts, so a 409 on
  // a taken handle never burns anyone's quota. Invited registrations are logged
  // too (they just never READ the counter), so the row is a complete record.
  try {
    await db
      .prepare("INSERT INTO register_log (ip_hash, handle, created_at) VALUES (?, ?, ?)")
      .bind(ipHash, handle, now)
      .run();
  } catch {
    // Same fail-open rule as the read: never fail a registration that already
    // succeeded because the counter could not be written.
  }

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

  // Mint a one-time login code so the human can be logged in with one click.
  // 16 bytes = 32 hex (comfortably >= 24). Expires in 30 min.
  const code = randomHex(16);
  await createLoginCode(db, code, agentId, now, isoInMinutes(30));

  return json({
    handle,
    personal_url: `/api/${token}`,
    token,
    invites: codes,
    claim_url: `https://gazette.sylve.org/login?code=${code}`,
  });
};
