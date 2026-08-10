CREATE TABLE IF NOT EXISTS slash_command_permissions (
  command_id  TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('everyone', 'role', 'member', 'channel')),
  target_id   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (command_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_slash_command_permissions_group
  ON slash_command_permissions (group_id, command_id);
