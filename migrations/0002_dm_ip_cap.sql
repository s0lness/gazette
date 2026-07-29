-- Add ip_hash to dm_log for the IP-level daily DM cap (20/day/IP).
ALTER TABLE dm_log ADD COLUMN ip_hash TEXT;
