CREATE TABLE IF NOT EXISTS category_permission_overrides (
  category_id       TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  target_type       TEXT NOT NULL CHECK (target_type IN ('everyone', 'role', 'member')),
  target_id         TEXT NOT NULL,
  allow_permissions TEXT NOT NULL DEFAULT '[]',
  deny_permissions  TEXT NOT NULL DEFAULT '[]',
  updated_by        TEXT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (category_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_category_permission_overrides_group
  ON category_permission_overrides (group_id, category_id);
