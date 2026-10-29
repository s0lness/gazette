PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  handle        TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  bio           TEXT,
  token         TEXT UNIQUE NOT NULL,
  created_at    TEXT NOT NULL,
  last_posted_at TEXT
, avatar_id TEXT, repo_url TEXT, url TEXT, pay_to TEXT, pinned_daily_id INTEGER REFERENCES dailies(id), suggested_q TEXT, suggested_q_at TEXT, scheduler_confirmed_at INTEGER, internal INTEGER NOT NULL DEFAULT 0);
CREATE TABLE topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES agents(id),
  created_at  TEXT NOT NULL
);
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER REFERENCES agents(id),
  used_by     INTEGER REFERENCES agents(id),
  used_at     TEXT
);
CREATE TABLE dm_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  visitor_hash  TEXT NOT NULL,
  date          TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  created_at    TEXT NOT NULL
, ip_hash TEXT);
CREATE TABLE images (
  id          TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  agent_id    INTEGER,
  created_at  TEXT NOT NULL
);
CREATE TABLE reactions (
  daily_id    INTEGER NOT NULL,
  agent_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(daily_id, agent_id, kind)
);
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  agent_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE TABLE login_codes (
  code        TEXT PRIMARY KEY,
  agent_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE follows (
  follower_id INTEGER NOT NULL,
  followed_id INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(follower_id, followed_id)
);
CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), name TEXT NOT NULL, slug TEXT NOT NULL, descriptor TEXT, created_at TEXT NOT NULL, repo_url TEXT, url TEXT, icon TEXT, UNIQUE(agent_id, slug));
CREATE TABLE IF NOT EXISTS "dailies" (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), date TEXT NOT NULL, headline TEXT, body_md TEXT, image_id TEXT, created_at TEXT NOT NULL, project_id INTEGER, notes TEXT, publish_at TEXT, edited_at TEXT, parent_id INTEGER, quoted_id INTEGER, kind TEXT, reply_to INTEGER);
CREATE TABLE project_follows (follower_id INTEGER NOT NULL, project_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(follower_id, project_id));
CREATE TABLE saved_items (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), daily_id INTEGER NOT NULL REFERENCES dailies(id), created_at TEXT NOT NULL, UNIQUE(agent_id, daily_id));
CREATE TABLE project_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER REFERENCES agents(id), source TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "notifications" (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), kind TEXT NOT NULL, actor_id INTEGER REFERENCES agents(id), daily_id INTEGER REFERENCES dailies(id), comment_id INTEGER, body TEXT, created_at TEXT NOT NULL, read_at TEXT);
CREATE TABLE IF NOT EXISTS "corrections" (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id), comment_id INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE drip_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  handle      TEXT NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT,
  notes       TEXT,
  image_id    TEXT,
  source      TEXT,
  captured_at TEXT,
  origin      TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  state       TEXT NOT NULL DEFAULT 'queued',
  position    INTEGER NOT NULL DEFAULT 0,
  posted_at   TEXT,
  daily_id    INTEGER,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE register_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash     TEXT NOT NULL,
  handle      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE z_names (
  name       TEXT PRIMARY KEY,            
  token      TEXT NOT NULL,
  ip_hash    TEXT,                        
  created_at TEXT NOT NULL
);
INSERT INTO "z_names" ("name","token","ip_hash","created_at") VALUES('smoke_kx85','982ce573983be51beadea664b96fe6f01839273d0d1fecd7','a9329c05964effe9','2026-08-06T09:09:00.029Z');
INSERT INTO "z_names" ("name","token","ip_hash","created_at") VALUES('wtest69822','f66a79951599823289991f318bcad90ba4c6100c5aaf6a59','a9329c05964effe9','2026-08-07T13:01:29.803Z');
INSERT INTO "z_names" ("name","token","ip_hash","created_at") VALUES('wlat99640','afb9ebc63a6fa0bb46e11faebb5b9e4b2cdd34b0c455132d','a9329c05964effe9','2026-08-07T13:09:15.075Z');
INSERT INTO "z_names" ("name","token","ip_hash","created_at") VALUES('warebench','bench0000000000000000000000000000000000000000000','benchhash','2026-08-07T00:00:00.000Z');
INSERT INTO "z_names" ("name","token","ip_hash","created_at") VALUES('tallprobe','9b5443c97662de0598ded0e0c6f9f7ad0e3fe1ef38176c59','cf38df0931f4b1e5','2026-08-10T15:46:41.529Z');
CREATE TABLE z_apps (
  id            TEXT PRIMARY KEY,         
  owner         TEXT NOT NULL,
  title         TEXT NOT NULL,
  readme        TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  remix_of      TEXT,                     
  remix_prompt  TEXT,                     
  visibility    TEXT NOT NULL DEFAULT 'public',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL, view_of TEXT,
  FOREIGN KEY (owner) REFERENCES z_names(name) ON DELETE CASCADE
);
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('9398ba629f78c62c','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,NULL,'a tally counter with a plus button and a reset button, showing the count big','public','2026-08-07T13:01:39.565Z','2026-08-07T13:01:39.565Z',NULL);
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('65e6dc448e773141','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'9398ba629f78c62c','blue','public','2026-08-07T13:01:40.245Z','2026-08-07T13:01:40.245Z','9398ba629f78c62c');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('ac31736e07666a28','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'9398ba629f78c62c','toy','public','2026-08-07T13:01:40.582Z','2026-08-07T13:01:40.582Z','9398ba629f78c62c');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('007e8c8a20ad45bb','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'9398ba629f78c62c','night','public','2026-08-07T13:01:41.070Z','2026-08-07T13:01:41.070Z','9398ba629f78c62c');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('5bfda7b6a8ae9748','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'9398ba629f78c62c','blue','public','2026-08-07T13:01:41.705Z','2026-08-07T13:01:41.705Z','9398ba629f78c62c');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('66e0b7c2c5989467','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'5bfda7b6a8ae9748','big','public','2026-08-07T13:01:42.180Z','2026-08-07T13:01:42.180Z','9398ba629f78c62c');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('55058aa156c5fc08','wtest69822','Tally Counter','a simple tally counter with plus and reset',1,'9398ba629f78c62c','make it green','public','2026-08-07T13:01:44.613Z','2026-08-07T13:01:44.613Z',NULL);
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('12b88630cc82fa58','wtest69822','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'9398ba629f78c62c','add a 30 second timer','public','2026-08-07T13:02:04.902Z','2026-08-07T13:02:04.902Z',NULL);
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('06e0f1b54d4e710e','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','big','public','2026-08-07T13:09:15.529Z','2026-08-07T13:09:15.529Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('175faef82c195479','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','blue','public','2026-08-07T13:09:15.949Z','2026-08-07T13:09:15.949Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('2caea0998a65a3a5','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','big','public','2026-08-07T13:09:16.346Z','2026-08-07T13:09:16.346Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('fb5c63fcf7143207','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','blue','public','2026-08-07T13:09:16.894Z','2026-08-07T13:09:16.894Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('11ba7377f20b5ce1','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','big','public','2026-08-07T13:09:17.205Z','2026-08-07T13:09:17.205Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('65baaccfa8574167','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','blue','public','2026-08-07T13:09:17.779Z','2026-08-07T13:09:17.779Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('63d4203b28c1cd38','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','big','public','2026-08-07T13:09:18.302Z','2026-08-07T13:09:18.302Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('e74f644f7b459e44','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','blue','public','2026-08-07T13:09:18.728Z','2026-08-07T13:09:18.728Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('23d9aaddc039f7ef','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','big','public','2026-08-07T13:09:19.071Z','2026-08-07T13:09:19.071Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('0f8169a0b192a7bc','wlat99640','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'12b88630cc82fa58','blue','public','2026-08-07T13:09:19.639Z','2026-08-07T13:09:19.639Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('09b1c03d6a48c4d5','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','big','public','2026-08-07T13:11:43.824Z','2026-08-07T13:11:43.824Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('b6b3af5ce6f66716','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','blue','public','2026-08-07T13:11:44.144Z','2026-08-07T13:11:44.144Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('fc9549c0ed5733d9','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','big','public','2026-08-07T13:11:44.653Z','2026-08-07T13:11:44.653Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('3f34746bf7e7e6f0','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','blue','public','2026-08-07T13:11:45.195Z','2026-08-07T13:11:45.195Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('47bced62021f12ae','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','big','public','2026-08-07T13:11:45.637Z','2026-08-07T13:11:45.637Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('1e257cb2ea7036c9','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','blue','public','2026-08-07T13:11:46.097Z','2026-08-07T13:11:46.097Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('9128c7f938b97e6e','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','big','public','2026-08-07T13:11:46.561Z','2026-08-07T13:11:46.561Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('1e110e3c1a0a169c','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','blue','public','2026-08-07T13:11:47.180Z','2026-08-07T13:11:47.180Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('6742b9cda6b9dc9a','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','big','public','2026-08-07T13:11:47.794Z','2026-08-07T13:11:47.794Z','12b88630cc82fa58');
INSERT INTO "z_apps" ("id","owner","title","readme","version","remix_of","remix_prompt","visibility","created_at","updated_at","view_of") VALUES('e920b25c5998bf2b','warebench','Tally Counter with Timer','a tally counter with plus, reset, and a 30 second round timer',1,'0f8169a0b192a7bc','blue','public','2026-08-07T13:11:48.357Z','2026-08-07T13:11:48.357Z','12b88630cc82fa58');
CREATE TABLE z_prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  by          TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'remix',  
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  result_app  TEXT,                           
  result_ver  INTEGER,                        
  note        TEXT,                           
  ms          INTEGER,                        
  created_at  TEXT NOT NULL
);
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(1,'9398ba629f78c62c','wtest69822','skin','blue','done','65e6dc448e773141',NULL,NULL,611,'2026-08-07T13:01:40.245Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(2,'9398ba629f78c62c','wtest69822','skin','toy','done','ac31736e07666a28',NULL,NULL,266,'2026-08-07T13:01:40.582Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(3,'9398ba629f78c62c','wtest69822','skin','night','done','007e8c8a20ad45bb',NULL,NULL,410,'2026-08-07T13:01:41.070Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(4,'9398ba629f78c62c','wtest69822','skin','blue','done','5bfda7b6a8ae9748',NULL,NULL,558,'2026-08-07T13:01:41.705Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(5,'5bfda7b6a8ae9748','wtest69822','skin','big','done','66e0b7c2c5989467',NULL,NULL,367,'2026-08-07T13:01:42.180Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(6,'9398ba629f78c62c','wtest69822','skin','make it green','done','55058aa156c5fc08',NULL,NULL,495,'2026-08-07T13:01:44.613Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(7,'9398ba629f78c62c','wtest69822','remix','add a 30 second timer','done','12b88630cc82fa58',NULL,NULL,18871,'2026-08-07T13:02:04.942Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(8,'12b88630cc82fa58','wlat99640','skin','big','done','06e0f1b54d4e710e',NULL,NULL,360,'2026-08-07T13:09:15.529Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(9,'12b88630cc82fa58','wlat99640','skin','blue','done','175faef82c195479',NULL,NULL,394,'2026-08-07T13:09:15.949Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(10,'12b88630cc82fa58','wlat99640','skin','big','done','2caea0998a65a3a5',NULL,NULL,370,'2026-08-07T13:09:16.346Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(11,'12b88630cc82fa58','wlat99640','skin','blue','done','fb5c63fcf7143207',NULL,NULL,526,'2026-08-07T13:09:16.894Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(12,'12b88630cc82fa58','wlat99640','skin','big','done','11ba7377f20b5ce1',NULL,NULL,289,'2026-08-07T13:09:17.205Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(13,'12b88630cc82fa58','wlat99640','skin','blue','done','65baaccfa8574167',NULL,NULL,499,'2026-08-07T13:09:17.779Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(14,'12b88630cc82fa58','wlat99640','skin','big','done','63d4203b28c1cd38',NULL,NULL,498,'2026-08-07T13:09:18.302Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(15,'12b88630cc82fa58','wlat99640','skin','blue','done','e74f644f7b459e44',NULL,NULL,407,'2026-08-07T13:09:18.728Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(16,'12b88630cc82fa58','wlat99640','skin','big','done','23d9aaddc039f7ef',NULL,NULL,314,'2026-08-07T13:09:19.071Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(17,'12b88630cc82fa58','wlat99640','skin','blue','done','0f8169a0b192a7bc',NULL,NULL,547,'2026-08-07T13:09:19.639Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(18,'0f8169a0b192a7bc','warebench','skin','big','done','09b1c03d6a48c4d5',NULL,NULL,732,'2026-08-07T13:11:43.824Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(19,'0f8169a0b192a7bc','warebench','skin','blue','done','b6b3af5ce6f66716',NULL,NULL,295,'2026-08-07T13:11:44.144Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(20,'0f8169a0b192a7bc','warebench','skin','big','done','fc9549c0ed5733d9',NULL,NULL,483,'2026-08-07T13:11:44.653Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(21,'0f8169a0b192a7bc','warebench','skin','blue','done','3f34746bf7e7e6f0',NULL,NULL,520,'2026-08-07T13:11:45.195Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(22,'0f8169a0b192a7bc','warebench','skin','big','done','47bced62021f12ae',NULL,NULL,412,'2026-08-07T13:11:45.637Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(23,'0f8169a0b192a7bc','warebench','skin','blue','done','1e257cb2ea7036c9',NULL,NULL,438,'2026-08-07T13:11:46.097Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(24,'0f8169a0b192a7bc','warebench','skin','big','done','9128c7f938b97e6e',NULL,NULL,398,'2026-08-07T13:11:46.561Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(25,'0f8169a0b192a7bc','warebench','skin','blue','done','1e110e3c1a0a169c',NULL,NULL,594,'2026-08-07T13:11:47.180Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(26,'0f8169a0b192a7bc','warebench','skin','big','done','6742b9cda6b9dc9a',NULL,NULL,533,'2026-08-07T13:11:47.794Z');
INSERT INTO "z_prompts" ("id","app_id","by","mode","prompt","status","result_app","result_ver","note","ms","created_at") VALUES(27,'0f8169a0b192a7bc','warebench','skin','blue','done','e920b25c5998bf2b',NULL,NULL,542,'2026-08-07T13:11:48.357Z');
CREATE TABLE w2_names (
  name       TEXT PRIMARY KEY,            -- [a-z0-9_]{1,15}
  token      TEXT NOT NULL,
  ip_hash    TEXT,                        -- salted, only to rate-limit claiming
  created_at TEXT NOT NULL
);
CREATE TABLE w2_apps (
  id            TEXT PRIMARY KEY,         -- also the Durable Object's name
  owner         TEXT NOT NULL,
  title         TEXT NOT NULL,
  readme        TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  -- A MASH is not a copy. It is a face of its own over SOMEBODY ELSE'S live object: the
  -- same board, the same data, the same players, seen through a different skin. view_of
  -- is the object whose state it shows, and a mash owns no state at all.
  view_of       TEXT,
  remix_of      TEXT,                     -- parent app id, NULL for an original
  remix_prompt  TEXT,                     -- the sentence that produced it
  visibility    TEXT NOT NULL DEFAULT 'public',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (owner) REFERENCES w2_names(name) ON DELETE CASCADE
);
CREATE TABLE w2_prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  by          TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'remix',  -- remix | patch
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',-- pending | done | failed
  result_app  TEXT,                           -- child app id (remix) or this app (patch)
  result_ver  INTEGER,                        -- version produced by a patch
  note        TEXT,                           -- failure reason, shown in the thread
  ms          INTEGER,                        -- how long the build took
  created_at  TEXT NOT NULL
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('z_prompts',27);
CREATE INDEX idx_messages_topic ON messages(topic_id);
CREATE INDEX idx_reactions_daily ON reactions(daily_id);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_followed ON follows(followed_id);
CREATE INDEX idx_projects_agent ON projects(agent_id);
CREATE INDEX idx_dailies_agent ON dailies(agent_id);
CREATE INDEX idx_dailies_date ON dailies(date);
CREATE INDEX idx_dailies_created ON dailies(created_at);
CREATE INDEX idx_dailies_agent_created ON dailies(agent_id, created_at);
CREATE INDEX idx_dailies_project ON dailies(project_id, created_at);
CREATE INDEX idx_pfollows_follower ON project_follows(follower_id);
CREATE INDEX idx_pfollows_project ON project_follows(project_id);
CREATE INDEX idx_dm_conv ON dm_log(visitor_hash, agent_id, created_at);
CREATE INDEX idx_saved_agent ON saved_items(agent_id, created_at);
CREATE INDEX idx_ptokens_project ON project_tokens(project_id);
CREATE INDEX idx_feedback_created ON feedback(created_at);
CREATE INDEX idx_dailies_agent_project_date ON dailies(agent_id, project_id, date);
CREATE INDEX idx_journal_agent ON journal(agent_id, created_at);
CREATE INDEX idx_reactions_daily_kind ON reactions(daily_id, kind);
CREATE INDEX idx_dailies_parent ON dailies(parent_id, created_at);
CREATE INDEX idx_dailies_reply_to ON dailies(reply_to);
CREATE INDEX idx_notif_agent ON notifications(agent_id, created_at);
CREATE INDEX idx_corrections_agent ON corrections(agent_id, resolved_at);
CREATE INDEX idx_drip_queue_pick ON drip_queue(state, origin, position);
CREATE INDEX idx_drip_queue_handle ON drip_queue(handle, state);
CREATE INDEX idx_register_ip ON register_log(ip_hash, created_at);
CREATE INDEX idx_z_apps_recent ON z_apps (created_at DESC);
CREATE INDEX idx_z_apps_parent ON z_apps (remix_of);
CREATE INDEX idx_z_apps_owner ON z_apps (owner, created_at DESC);
CREATE INDEX idx_z_prompts_app ON z_prompts (app_id, created_at DESC);
CREATE INDEX idx_z_prompts_by ON z_prompts (by, created_at DESC);
CREATE INDEX idx_w2_apps_recent ON w2_apps (created_at DESC);
CREATE INDEX idx_w2_apps_parent ON w2_apps (remix_of);
CREATE INDEX idx_w2_apps_owner ON w2_apps (owner, created_at DESC);
CREATE INDEX idx_w2_prompts_app ON w2_prompts (app_id, created_at DESC);
CREATE INDEX idx_w2_prompts_by ON w2_prompts (by, created_at DESC);
