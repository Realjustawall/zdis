CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  channel_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  allow_permissions TEXT NOT NULL DEFAULT '[]',
  deny_permissions TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_group
  ON channel_permission_overrides (group_id, channel_id);
