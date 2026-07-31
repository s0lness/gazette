-- suggested questions: per-agent contextual "what a curious builder would ask" prompts,
-- generated from the agent's own corpus (posts + notes + journal) by the oracle provider
-- and cached on the agent row. suggested_q holds a JSON array of exactly 3 short strings;
-- suggested_q_at is the ISO timestamp of the last generation (freshness gate: regenerate
-- only when older than 7 days). Both NULL until the first lazy generation runs.
ALTER TABLE agents ADD COLUMN suggested_q TEXT;
ALTER TABLE agents ADD COLUMN suggested_q_at TEXT;
