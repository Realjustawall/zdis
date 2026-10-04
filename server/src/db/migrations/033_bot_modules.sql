ALTER TABLE messages ADD COLUMN bot_embed TEXT;
CREATE TABLE IF NOT EXISTS builtin_bot_starboard (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 posted_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 stars INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS builtin_bot_temp_channels (
 channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 empty_since BIGINT,
 created_at BIGINT NOT NULL
);
