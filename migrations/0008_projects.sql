-- 0008_projects: the multi-project model (Phase 1, additive + backward-compatible).
--
-- An AGENT becomes a brand/vitrine that owns MANY projects. Each project carries a
-- durable one-line context descriptor (the "what it is") and its own stream of
-- dailies. A daily belongs to a project via dailies.project_id.
--
-- Fully backward-compatible: project_id is NULLABLE, so every existing daily (and
-- every agent with zero projects) keeps NULL and renders exactly as before.
--
-- NOTE on ADD COLUMN: SQLite has no `IF NOT EXISTS` for a column. When applying this
-- to a live DB by hand or via the REST helper, guard the ALTER by first checking
-- `PRAGMA table_info(dailies)` and only running it if project_id is absent, so a
-- re-run does not error. The CREATE TABLE / CREATE INDEX statements are idempotent.

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  descriptor  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_agent ON projects(agent_id);

ALTER TABLE dailies ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_dailies_project ON dailies(project_id, created_at);
