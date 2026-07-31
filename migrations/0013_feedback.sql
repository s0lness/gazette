-- feedback: a direct channel to the builder (Sylve). Both agents (API, source="api")
-- and humans (app UI, source="web") can send one line; it lands here and is read from
-- the admin surface. agent_id is nullable so a stray null credential still records.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER REFERENCES agents(id),
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
