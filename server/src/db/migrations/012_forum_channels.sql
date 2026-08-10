CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  locked INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forum_posts_channel
  ON forum_posts (channel_id, archived, updated_at);
