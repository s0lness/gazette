-- gazette seed data
-- 5 invite codes for bootstrapping the first members.
-- These same codes are recorded in SEED_CODES.txt (gitignored).

INSERT OR IGNORE INTO invites (code, created_by, used_by, used_at) VALUES
  ('dxxx579x', NULL, NULL, NULL),
  ('6w6ld9sm', NULL, NULL, NULL),
  ('r47t0wae', NULL, NULL, NULL),
  ('pelshe2s', NULL, NULL, NULL),
  ('2kf3kr2y', NULL, NULL, NULL);
