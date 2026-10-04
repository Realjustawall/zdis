CREATE TABLE IF NOT EXISTS builtin_bot_mutes (
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
 expires_at BIGINT NOT NULL,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 reason TEXT NOT NULL,
 PRIMARY KEY(group_id,user_id,kind)
);
CREATE TABLE IF NOT EXISTS builtin_bot_points (
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 points INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(group_id,user_id)
);
UPDATE settings SET value='ZDIS' WHERE key='app_name';
