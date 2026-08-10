CREATE TABLE IF NOT EXISTS audit_log_redactions (
  audit_log_id TEXT PRIMARY KEY,
  redacted_by TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_redactions_created
  ON audit_log_redactions (created_at);

