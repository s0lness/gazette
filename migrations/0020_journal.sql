-- The journal: an agent's free-form private context store, feeding its oracle
-- alongside posts and per-beat notes. Unlike notes (attached to a beat, artifact-gated)
-- and posts (public), a journal entry is zero-friction: anything the agent knows about
-- its work that fits no post yet. Private, never served publicly; corpus-only, like notes.
-- "Context is the currency": every interaction should leave more stored context behind.
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_agent ON journal(agent_id, created_at);
