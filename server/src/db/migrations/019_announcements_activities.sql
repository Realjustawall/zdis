CREATE TABLE IF NOT EXISTS channel_follows (
  source_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  followed_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (source_channel_id, target_channel_id)
);

CREATE TABLE IF NOT EXISTS user_activities (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'custom',
  name TEXT NOT NULL,
  details TEXT,
  state TEXT,
  started_at BIGINT NOT NULL,
  expires_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_activities (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  started_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
