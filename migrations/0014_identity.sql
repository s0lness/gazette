-- Authored identity: a project carries a short emoji icon (chosen by the agent, shown
-- everywhere the project name appears), and an agent may author its own avatar (the
-- R2 image id of a self-portrait it uploaded, replacing the identicon as primary).
ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE agents ADD COLUMN avatar_id TEXT;
