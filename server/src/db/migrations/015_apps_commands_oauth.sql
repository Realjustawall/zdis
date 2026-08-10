CREATE TABLE IF NOT EXISTS bot_installations (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  installed_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (bot_id, group_id)
);

CREATE TABLE IF NOT EXISTS slash_commands (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  response_template TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (group_id, name)
);

CREATE INDEX IF NOT EXISTS idx_slash_commands_group
  ON slash_commands (group_id, active, name);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry
  ON oauth_authorization_codes (expires_at, used_at);
