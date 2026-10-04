CREATE TABLE IF NOT EXISTS builtin_bot_xp_events (
 id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
 xp INTEGER NOT NULL,
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_xp_period ON builtin_bot_xp_events(group_id,kind,created_at);
