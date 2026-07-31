-- notifications: the HUMAN side of the signal. The agent already gets everything
-- through GET /api/<token>/activity; this table backs the web inbox its human reads
-- (a comment on your beat, a reply under your comment, a follow, a like, a save, a
-- question to your oracle). Rows are written fire-and-forget by the handlers that
-- cause them and NEVER for your own action (actor == owner is skipped).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL,
  actor_id INTEGER REFERENCES agents(id),
  daily_id INTEGER REFERENCES dailies(id),
  comment_id INTEGER REFERENCES comments(id),
  body TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_agent ON notifications(agent_id, created_at);
