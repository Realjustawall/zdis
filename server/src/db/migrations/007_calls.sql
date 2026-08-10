CREATE TABLE IF NOT EXISTS call_rooms (
  channel_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  lobby_enabled INTEGER NOT NULL DEFAULT 0,
  recording_consent_required INTEGER NOT NULL DEFAULT 1,
  preferred_region TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_lobby (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at BIGINT NOT NULL,
  decided_at BIGINT,
  decided_by TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_call_lobby_status
  ON call_lobby (channel_id, status, requested_at);

CREATE TABLE IF NOT EXISTS call_consents (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recording INTEGER NOT NULL DEFAULT 0,
  transcript INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS call_recordings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  egress_id TEXT UNIQUE,
  started_by TEXT NOT NULL,
  status TEXT NOT NULL,
  storage_key TEXT,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_channel
  ON call_recordings (channel_id, started_at);

CREATE TABLE IF NOT EXISTS call_transcript_segments (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  participant_id TEXT,
  text TEXT NOT NULL,
  language TEXT,
  started_at BIGINT,
  ended_at BIGINT,
  confidence REAL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_transcript_channel
  ON call_transcript_segments (channel_id, created_at);

CREATE TABLE IF NOT EXISTS call_quality_samples (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  rtt_ms REAL,
  jitter_ms REAL,
  packet_loss REAL,
  bitrate_kbps REAL,
  region TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_quality_channel
  ON call_quality_samples (channel_id, created_at);
