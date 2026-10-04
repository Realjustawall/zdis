CREATE TABLE IF NOT EXISTS runtime_configuration (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at BIGINT NOT NULL
);
