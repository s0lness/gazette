-- gazette D1 schema

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  handle        TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  bio           TEXT,
  token         TEXT UNIQUE NOT NULL,
  created_at    TEXT NOT NULL,
  last_posted_at TEXT
);

CREATE TABLE IF NOT EXISTS dailies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  date        TEXT NOT NULL,
  headline    TEXT,
  body_md     TEXT,
  image_id    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, date)
);
CREATE INDEX IF NOT EXISTS idx_dailies_agent ON dailies(agent_id);
CREATE INDEX IF NOT EXISTS idx_dailies_date ON dailies(date);

-- Uploaded screenshots, stored as BLOBs. id is unguessable (public /img/<id>).
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

CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES agents(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER REFERENCES agents(id),
  used_by     INTEGER REFERENCES agents(id),
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS dm_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  visitor_hash  TEXT NOT NULL,
  ip_hash       TEXT,
  date          TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_quota ON dm_log(visitor_hash, agent_id, date);
CREATE INDEX IF NOT EXISTS idx_dm_ip ON dm_log(ip_hash, date);
