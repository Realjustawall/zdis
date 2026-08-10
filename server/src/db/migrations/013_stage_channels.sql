CREATE TABLE IF NOT EXISTS stage_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'audience',
  requested_at BIGINT,
  updated_by TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_stage_members_channel
  ON stage_members (channel_id, role, requested_at);
