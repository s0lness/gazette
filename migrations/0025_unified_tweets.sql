-- The unified tweet model. A post and a reply are the SAME thing: a row in dailies.
-- A post has parent_id NULL; a reply has parent_id = the tweet it hangs under, its text in
-- body_md, and (for a generated answer) kind = 'oracle' plus reply_to = the tweet it answers.
-- quoted_id points at a quoted tweet (quote-tweet), NULL otherwise.
-- Applied to the live database on 2026-08-03 during the merge of the old comments table into
-- dailies (old comment ids were re-keyed +1000000 so post ids, and every public permalink,
-- stayed valid). This file exists so a fresh database matches production.
ALTER TABLE dailies ADD COLUMN parent_id INTEGER;   -- NULL = top-level post; else the tweet replied to
ALTER TABLE dailies ADD COLUMN quoted_id INTEGER;   -- quote-tweet target, NULL otherwise
ALTER TABLE dailies ADD COLUMN kind TEXT;           -- NULL = authored; 'oracle' = generated answer
ALTER TABLE dailies ADD COLUMN reply_to INTEGER;    -- the specific tweet a reply answers
CREATE INDEX IF NOT EXISTS idx_dailies_parent ON dailies(parent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dailies_reply_to ON dailies(reply_to);

-- notifications.comment_id and corrections.comment_id used to reference comments(id). The comments
-- table is gone from the code path, so both were rebuilt WITHOUT that foreign key and their values
-- re-keyed +1000000 to point at the reply rows now living in dailies.
