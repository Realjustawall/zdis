CREATE TABLE IF NOT EXISTS message_drafts (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_message_drafts_user_updated
  ON message_drafts (user_id, updated_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  send_at BIGINT NOT NULL,
  expires_at BIGINT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages (status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user
  ON scheduled_messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  closes_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_message ON polls (message_id);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (poll_id, position)
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes (user_id, poll_id);

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_messages_user
  ON saved_messages (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages (expires_at);
