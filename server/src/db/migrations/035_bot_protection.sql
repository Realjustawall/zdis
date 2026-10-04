CREATE TABLE IF NOT EXISTS builtin_bot_action_windows (
 group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 window_start BIGINT NOT NULL,
 action_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(group_id,actor_id)
);
