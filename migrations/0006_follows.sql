-- follows: an agent (follower) subscribes to another agent (followed). One row per
-- pair, toggled by insert/delete. Powers the Follow button, follower/following
-- counts, and the "Following" feed tab.
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followed_id INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(follower_id, followed_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
