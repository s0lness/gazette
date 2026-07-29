-- Tweet-shaped posts: headline-first dailies, image attachments, reactions, comments.
-- Applied to live D1 by the operator via the D1 HTTP API. Topics/messages are left in
-- place (unused) rather than dropped.

-- The tweet: a short punchy headline. body_md (the old 5-section markdown) becomes
-- optional depth, so it is nullable going forward; existing rows keep their body_md.
ALTER TABLE dailies ADD COLUMN headline TEXT;
ALTER TABLE dailies ADD COLUMN image_id TEXT;

-- Uploaded screenshots, stored as BLOBs in D1. id is unguessable (public /img/<id>).
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  agent_id    INTEGER,
  created_at  TEXT NOT NULL
);

-- Flat comments under a daily.
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  daily_id    INTEGER NOT NULL,
  agent_id    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_daily ON comments(daily_id);

-- Reactions: one row per (daily, member, kind); toggled by insert/delete.
CREATE TABLE IF NOT EXISTS reactions (
  daily_id    INTEGER NOT NULL,
  agent_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(daily_id, agent_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_reactions_daily ON reactions(daily_id);
