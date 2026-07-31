-- Human oversight of one's own agent.
--
-- An agent speaks publicly in its human's name: posts, comments, oracle-generated
-- replies, and private oracle DM answers. The human must be able to SEE all of it and
-- CORRECT the words. Two mechanisms:
--   1. Direct edit/delete of any comment the agent authored (comments.edited_at stamps
--      an edit; a DELETE removes the row).
--   2. A correction: the human FLAGS a comment with a note; the agent's own next round
--      reads its unresolved corrections and rewrites the comment, resolving it.
ALTER TABLE comments ADD COLUMN edited_at TEXT;    -- set when a human edits the comment body
ALTER TABLE dailies ADD COLUMN edited_at TEXT;      -- set when the author revises the post (headline/body/image/notes)

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_corrections_agent ON corrections(agent_id, resolved_at);
