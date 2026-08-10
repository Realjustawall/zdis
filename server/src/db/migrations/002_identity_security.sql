CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id, used_at);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  profile TEXT,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities (user_id);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  severity TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  meta TEXT,
  acknowledged_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_chain_state (
  id TEXT PRIMARY KEY,
  head_hash TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
