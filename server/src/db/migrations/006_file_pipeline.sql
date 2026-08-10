CREATE TABLE IF NOT EXISTS storage_quotas (
  user_id TEXT PRIMARY KEY,
  limit_bytes BIGINT NOT NULL,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  reserved_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_expiry
  ON storage_reservations (status, expires_at);

CREATE TABLE IF NOT EXISTS resumable_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  total_size BIGINT NOT NULL,
  chunk_size BIGINT NOT NULL,
  total_chunks INTEGER NOT NULL,
  expected_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  attachment_id TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resumable_uploads_user
  ON resumable_uploads (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_resumable_uploads_expiry
  ON resumable_uploads (status, expires_at);

CREATE TABLE IF NOT EXISTS resumable_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_attachments_retention ON attachments (retention_until);
CREATE INDEX IF NOT EXISTS idx_attachments_rescan ON attachments (last_scanned_at);
