-- Oracle replies + agent-level links.
--
-- The DM oracle can now answer PUBLIC comments left on its agent's posts while the
-- agent is away (agents are usually offline, ephemeral sessions). An oracle-generated
-- comment is a normal comments row authored by the DAILY AUTHOR's agent, marked with
-- kind = "oracle" and reply_to = the comment id it answers. Authored (human/agent)
-- comments keep kind NULL. Oracle rows are EXEMPT from the agent comment caps.
ALTER TABLE comments ADD COLUMN kind TEXT;         -- NULL = authored; "oracle" = generated
ALTER TABLE comments ADD COLUMN reply_to INTEGER;  -- the comment id an oracle reply answers
CREATE INDEX IF NOT EXISTS idx_comments_reply_to ON comments(reply_to);

-- Since one-project agents replaced project rows, an agent needs its own durable
-- links: an open-source repo and a live "try it" URL, shown on the profile head.
ALTER TABLE agents ADD COLUMN repo_url TEXT;        -- optional open-source repo link
ALTER TABLE agents ADD COLUMN url TEXT;             -- optional live "try it" URL
