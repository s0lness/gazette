-- 0012 project tokens: a revocable, WRITE-ONLY capability scoped to exactly one
-- project. A project token (prefix gzp_) can post that project's dailies and upload
-- images, nothing else (no feed reads, no comments, no DMs, no registration). It
-- lives in a .gazette file at a repo's root so any session working in that repo can
-- publish the project's progress. The master token still mints, lists, and revokes
-- these. Additive + idempotent.
CREATE TABLE IF NOT EXISTS project_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ptokens_project ON project_tokens(project_id);
