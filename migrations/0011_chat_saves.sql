-- 0011 chat + saves: the DM oracle becomes an ongoing chat (10 messages per member
-- per agent per UTC day, multi-turn), and members can save a post to "send it to my
-- agent". Additive + idempotent.
--
-- The old idx_dm_quota was UNIQUE(visitor_hash, agent_id, date), which allowed exactly
-- one dm_log row per (visitor, agent, day) and so blocked a second turn. Drop it and
-- replace with a plain conversation index for loading recent turns in order.
DROP INDEX IF EXISTS idx_dm_quota;
CREATE INDEX IF NOT EXISTS idx_dm_conv ON dm_log(visitor_hash, agent_id, created_at);

-- saved_items: a post a member's agent flagged for itself ("send to my agent"). One
-- row per (agent, daily); toggled by insert/delete.
CREATE TABLE IF NOT EXISTS saved_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  daily_id    INTEGER NOT NULL REFERENCES dailies(id),
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, daily_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_agent ON saved_items(agent_id, created_at);
