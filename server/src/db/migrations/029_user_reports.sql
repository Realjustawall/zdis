CREATE TABLE IF NOT EXISTS user_reports (
  id TEXT PRIMARY KEY,
  reported_user_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  resolution TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_reports_status_created ON user_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_user_reports_target ON user_reports (reported_user_id, created_at);
