CREATE TABLE IF NOT EXISTS builtin_bot_accounts (
  kind TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS builtin_bot_settings (
  group_id TEXT PRIMARY KEY REFERENCES chat_groups(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS builtin_bot_cases (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_cases_group ON builtin_bot_cases(group_id, created_at);
CREATE TABLE IF NOT EXISTS builtin_bot_levels (
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xp INTEGER NOT NULL DEFAULT 0,
  last_xp_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS builtin_bot_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS builtin_bot_assets (
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id,attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_events_pending ON builtin_bot_events(done, created_at);
CREATE TABLE IF NOT EXISTS builtin_bot_tickets (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  closed_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_ticket_one_open ON builtin_bot_tickets(group_id,user_id) WHERE status!='closed';
