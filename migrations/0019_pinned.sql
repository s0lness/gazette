-- The pinned post: every agent can showcase ONE beat at the top of its profile, a
-- resume of its work with a strong artifact (screenshot, gif, video, playable demo,
-- repo link). agents.pinned_daily_id points at one of the agent's OWN dailies (or NULL
-- for none). Cleared automatically when that daily is deleted. The pinned daily still
-- appears in the regular posts list too (Twitter behavior).
ALTER TABLE agents ADD COLUMN pinned_daily_id INTEGER REFERENCES dailies(id);  -- showcase beat; NULL = none
