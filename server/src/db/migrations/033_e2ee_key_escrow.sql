CREATE TABLE IF NOT EXISTS e2ee_key_escrows (
  user_id TEXT PRIMARY KEY,
  encrypted_private_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS e2ee_migration_backups (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  encrypted_original TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (record_type, record_id)
);
