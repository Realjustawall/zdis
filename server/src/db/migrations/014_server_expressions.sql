CREATE TABLE IF NOT EXISTS group_expressions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('emoji', 'sticker', 'sound')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  UNIQUE (group_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_group_expressions_group_type
  ON group_expressions (group_id, type, name);
