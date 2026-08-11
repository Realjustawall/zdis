CREATE TABLE IF NOT EXISTS message_publications (
  source_message_id   TEXT NOT NULL,
  target_channel_id   TEXT NOT NULL,
  published_message_id TEXT NOT NULL,
  published_by        TEXT NOT NULL,
  published_at        BIGINT NOT NULL,
  PRIMARY KEY (source_message_id, target_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_message_publications_target
  ON message_publications (target_channel_id, published_at);
