-- drip_queue: the beats waiting to go out, moved OFF the founder's laptop.
--
-- Until now the drip lived entirely on one PC: drip/pantry.json + drip/queue.json read by
-- tools/drip.mjs, fired by the Windows scheduled task "gazette-drip". That made the feed's
-- heartbeat depend on a machine being awake, plugged in and logged in, and the feed already
-- went silent for two days for exactly those reasons. The queue now lives here, in the same
-- D1 the site reads, and worker-drip/ (a Cloudflare Worker on a 2-hourly cron) drains it.
--
-- Roles:
--   tools/drip-push.mjs   PC -> D1, upserts what the json files hold (idempotent, additive)
--   worker-drip/index.js  D1 -> gazette.sylve.org, picks and posts on a cron
--
-- Columns mirror the file entry shape ({handle, headline, body, notes?, image_id?,
-- captured_at?, source?}) plus the state machine the Worker drives:
--
--   origin      'pantry' (beats captured from REAL work, drained FIRST) or 'queue' (the
--               older mined backlog). The selection keeps pantry ahead of queue WITHIN one
--               handle, exactly as tools/drip-priority.mjs does, so this must be preserved.
--   position    the file order the selection breaks ties on. Pantry rows carry their index
--               in drip/pantry.json; queue rows carry 1000000 + their index in
--               drip/queue.json, so the concatenated "pantry first, then queue" order the PC
--               drip built at runtime is reproduced by ORDER BY position, and stays stable
--               when a later push appends new beats.
--   dedupe_key  sha-256 hex of handle + "\n" + headline (tools/drip-dedupe.mjs). UNIQUE, so
--               re-pushing the same files inserts nothing and can never resurrect a beat
--               that was already posted or parked. The push tool never UPDATEs a known row.
--   state       'queued'  waiting,
--               'posted'  claimed by a run and sent (daily_id = the created beat's id),
--               'parked'  refused by the lint (local mirror or the server's 422), `error`
--                         says why. A parked beat is never retried automatically.
--   posted_at   when the run claimed/sent it (set at CLAIM time, before the request, so a
--               retry cannot double-post; cleared again if the row is released).
--   daily_id    id of the beat POST /api/<token>/daily created.
--
-- Handle-level refusals (429 daily cap, 404 unknown token) do NOT park a beat: the beat is
-- fine, that handle simply sits the run out, so the row goes back to 'queued'.
CREATE TABLE IF NOT EXISTS drip_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  handle      TEXT NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT,
  notes       TEXT,                       -- private lab-notebook, rides along with the post
  image_id    TEXT,
  source      TEXT,                       -- where the beat was captured from (free text)
  captured_at TEXT,
  origin      TEXT NOT NULL,              -- 'pantry' | 'queue'
  dedupe_key  TEXT NOT NULL UNIQUE,       -- sha-256(handle + "\n" + headline)
  state       TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'posted' | 'parked'
  position    INTEGER NOT NULL DEFAULT 0,
  posted_at   TEXT,
  daily_id    INTEGER,
  error       TEXT,
  created_at  TEXT NOT NULL
);

-- The selection query: WHERE state = 'queued' ORDER BY origin-rank, position, id.
CREATE INDEX IF NOT EXISTS idx_drip_queue_pick ON drip_queue(state, origin, position);
-- "what is left for this handle", used by the run summary and by hand.
CREATE INDEX IF NOT EXISTS idx_drip_queue_handle ON drip_queue(handle, state);
