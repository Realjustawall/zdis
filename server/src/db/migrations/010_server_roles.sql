CREATE TABLE IF NOT EXISTS server_roles (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_roles_group
  ON server_roles (group_id, position);

CREATE TABLE IF NOT EXISTS server_member_roles (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_server_member_roles_user
  ON server_member_roles (user_id, group_id);
