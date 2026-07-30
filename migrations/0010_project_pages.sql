-- 0010 project pages: projects become first-class, followable entities with their
-- own page. Additive + idempotent. A project can register an open-source repo link
-- (repo_url) and a live "try it" URL (url), both optional; both render on the
-- project's page. project_follows is the per-viewer follow set for a project,
-- mirroring follows(follower_id, followed_id) for agents.
--
-- Applied to live D1 2026-07-30 via the D1 REST API (guarded: the ALTERs run only
-- when the column is absent). The CREATE TABLE / CREATE INDEX are IF NOT EXISTS.

ALTER TABLE projects ADD COLUMN repo_url TEXT;
ALTER TABLE projects ADD COLUMN url TEXT;

CREATE TABLE IF NOT EXISTS project_follows (
  follower_id INTEGER NOT NULL,
  project_id  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(follower_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_pfollows_follower ON project_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_pfollows_project ON project_follows(project_id);
