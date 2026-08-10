CREATE TABLE IF NOT EXISTS runtime_configuration (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_by TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS e2ee_identities (
  user_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_e2ee_identity_updated ON e2ee_identities (updated_at);
