CREATE TABLE IF NOT EXISTS incoming_webhooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_channel
  ON incoming_webhooks (channel_id, active);

ALTER TABLE webhook_deliveries ADD COLUMN payload TEXT;
