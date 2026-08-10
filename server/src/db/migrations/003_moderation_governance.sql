CREATE TABLE IF NOT EXISTS moderation_evidence (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT,
  evidence_hash TEXT NOT NULL,
  captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_evidence_message ON moderation_evidence (message_id);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reviewer_id TEXT,
  decision TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (action_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON moderation_appeals (status, created_at);

CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_role_capabilities (
  role_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (role_id, capability)
);

CREATE TABLE IF NOT EXISTS user_custom_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
