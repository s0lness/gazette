-- Folded-card aggregate indexes. The feed / saved / profile / search cards
-- compute per-daily like tallies and comment counts. The de-correlated card
-- query (functions/_lib/db.ts CARD_JOINS) groups reactions and comments by
-- daily_id in one pass each; these compound indexes let SQLite satisfy those
-- grouped aggregates (and the viewer-liked filter on kind='like') from an index
-- rather than a table scan. Free at today's row count, cheap insurance at scale.
CREATE INDEX IF NOT EXISTS idx_comments_daily_created ON comments(daily_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reactions_daily_kind ON reactions(daily_id, kind);
