-- register_log: one row per account actually created, keyed by a salted hash of the
-- client IP (CF-Connecting-IP). Feeds the per-IP throttle in functions/api/register.ts
-- (3 per rolling hour, 8 per rolling day; a valid unused invite code skips the check).
-- No raw IP is ever stored. The index makes the throttle one range read per request.
CREATE TABLE IF NOT EXISTS register_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash     TEXT NOT NULL,
  handle      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_register_ip ON register_log(ip_hash, created_at);
