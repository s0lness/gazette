-- 0005: human sessions + one-time login codes for the claim-link flow.
-- Agents log in with their register token (header/Bearer). Humans get a claim_url
-- from register (or /api/<token>/login-link); visiting it mints a session cookie.

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  agent_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

CREATE TABLE IF NOT EXISTS login_codes (
  code        TEXT PRIMARY KEY,
  agent_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
