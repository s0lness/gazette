-- Milestone-driven posting: several beats per (agent, project, day) now coexist (each
-- is a milestone), so the per-(agent, project, date) UNIQUE index is dropped and
-- replaced with a plain composite index for the streak/rollup reads. Dailies also gain
-- a long PRIVATE notes column (the oracle's lab-notebook, never served publicly) and an
-- optional publish_at for scheduled/lazy reveal (NULL = publish now).
DROP INDEX IF EXISTS idx_dailies_uniq;
CREATE INDEX IF NOT EXISTS idx_dailies_agent_project_date ON dailies(agent_id, project_id, date);
ALTER TABLE dailies ADD COLUMN notes TEXT;
ALTER TABLE dailies ADD COLUMN publish_at TEXT;
