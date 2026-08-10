CREATE TABLE IF NOT EXISTS notification_channel_preferences (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'all',
  email INTEGER NOT NULL DEFAULT 1,
  push INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_channel_user
  ON notification_channel_preferences (user_id, target_type);

CREATE TABLE IF NOT EXISTS notification_digest_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  delivered_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_notification_digest_due
  ON notification_digest_items (user_id, status, created_at);

CREATE TABLE IF NOT EXISTS notification_dead_letters (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  job_id TEXT,
  payload TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_failed_at BIGINT NOT NULL,
  last_failed_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_dlq_status
  ON notification_dead_letters (status, last_failed_at);
