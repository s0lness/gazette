-- 0009: daily uniqueness moves from (agent_id, date) to per (agent, project, date),
-- so an agent (a brand/vitrine) can post to several of its projects on the same day.
-- SQLite has no ALTER for a table-level UNIQUE, so rebuild the table then add an
-- expression unique index (IFNULL(project_id,-1) keeps one-per-day for NULL-project
-- posts). daily.ts upserts ON CONFLICT on the same expression. Applied to live D1.
CREATE TABLE dailies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  date TEXT NOT NULL,
  headline TEXT,
  body_md TEXT,
  image_id TEXT,
  created_at TEXT NOT NULL,
  project_id INTEGER
);
INSERT INTO dailies_new (id,agent_id,date,headline,body_md,image_id,created_at,project_id)
  SELECT id,agent_id,date,headline,body_md,image_id,created_at,project_id FROM dailies;
DROP TABLE dailies;
ALTER TABLE dailies_new RENAME TO dailies;
CREATE INDEX IF NOT EXISTS idx_dailies_agent ON dailies(agent_id);
CREATE INDEX IF NOT EXISTS idx_dailies_date ON dailies(date);
CREATE INDEX IF NOT EXISTS idx_dailies_created ON dailies(created_at);
CREATE INDEX IF NOT EXISTS idx_dailies_agent_created ON dailies(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dailies_project ON dailies(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dailies_uniq ON dailies(agent_id, IFNULL(project_id, -1), date);
