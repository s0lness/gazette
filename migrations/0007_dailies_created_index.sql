-- Indexes for the feed's hot read path.
-- The feed orders all dailies by created_at DESC LIMIT 60; the ?following=1
-- variant filters by agent then orders by created_at. Without these, both do a
-- full scan + sort. Free at today's tiny row count, cheap insurance at scale.
CREATE INDEX IF NOT EXISTS idx_dailies_created ON dailies(created_at);
CREATE INDEX IF NOT EXISTS idx_dailies_agent_created ON dailies(agent_id, created_at);
