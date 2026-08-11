-- youtBeLimo schema.
-- Deliberately written in the portable subset shared by SQLite and PostgreSQL:
--   * ids are application-generated TEXT (sortable, see lib/ids.js)
--   * timestamps are BIGINT epoch milliseconds
--   * booleans are INTEGER 0/1
-- Do not introduce dialect-specific types here.

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  phone                 TEXT UNIQUE,
  username              TEXT NOT NULL UNIQUE,
  first_name            TEXT,
  last_name             TEXT,
  nickname              TEXT,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  password_changed_at   BIGINT NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  role                  TEXT NOT NULL DEFAULT 'member',
  avatar_url            TEXT,
  banner_color          TEXT,
  bio                   TEXT,
  presence              TEXT NOT NULL DEFAULT 'offline',
  custom_status         TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  totp_secret           TEXT,
  totp_enabled          INTEGER NOT NULL DEFAULT 0,
  tts_button_enabled    INTEGER NOT NULL DEFAULT 1,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          BIGINT,
  last_login_at         BIGINT,
  last_seen_at          BIGINT,
  created_by            TEXT,
  -- Accounts provisioned by a streamer are scoped to that streamer: they only
  -- see that person's groups unless another streamer is granted access.
  owner_streamer_id     TEXT,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_owner_streamer ON users (owner_streamer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone);

-- Identity badges. `primary` badges are granted only by an administrator and
-- carry the platform capabilities; `secondary` badges are team labels any
-- streamer may hand out to people on their own roster.
CREATE TABLE IF NOT EXISTS badges (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'primary',
  icon       TEXT NOT NULL DEFAULT 'star',
  color      TEXT NOT NULL DEFAULT '#5865f2',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id    TEXT NOT NULL,
  badge_id   TEXT NOT NULL,
  granted_by TEXT,
  granted_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges (badge_id);

-- Platform handles shown on a profile. `verified` is set only by an admin.
CREATE TABLE IF NOT EXISTS linked_accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  handle      TEXT NOT NULL,
  url         TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_user ON linked_accounts (user_id);

CREATE TABLE IF NOT EXISTS friendships (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   BIGINT NOT NULL,
  responded_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_pair ON friendships (requester_id, addressee_id);
CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships (addressee_id);

-- Two streamers working together; accepting creates a shared group.
CREATE TABLE IF NOT EXISTS collabs (
  id           TEXT PRIMARY KEY,
  initiator_id TEXT NOT NULL,
  partner_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  title        TEXT,
  note         TEXT,
  group_id     TEXT,
  created_at   BIGINT NOT NULL,
  responded_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_collab_partner ON collabs (partner_id);
CREATE INDEX IF NOT EXISTS idx_collab_initiator ON collabs (initiator_id);

-- A streamer asking another streamer's member for access to their spaces.
CREATE TABLE IF NOT EXISTS access_requests (
  id           TEXT PRIMARY KEY,
  streamer_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  message      TEXT,
  created_at   BIGINT NOT NULL,
  responded_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_pair ON access_requests (streamer_id, user_id);
CREATE INDEX IF NOT EXISTS idx_access_user ON access_requests (user_id);

CREATE TABLE IF NOT EXISTS channel_categories (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_group ON channel_categories (group_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_secret   TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  revoked_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS chat_groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  icon_url      TEXT,
  accent_color  TEXT,
  discovery_requested INTEGER NOT NULL DEFAULT 0,
  discoverable INTEGER NOT NULL DEFAULT 0,
  discovery_verified_by TEXT,
  discovery_verified_at BIGINT,
  owner_id      TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_owner ON chat_groups (owner_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  nickname   TEXT,
  muted      INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT,
  joined_at  BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);

CREATE TABLE IF NOT EXISTS server_roles (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_default  INTEGER NOT NULL DEFAULT 0,
  hoist       INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_roles_group ON server_roles (group_id, position);

CREATE TABLE IF NOT EXISTS server_member_roles (
  group_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_server_member_roles_user ON server_member_roles (user_id, group_id);

CREATE TABLE IF NOT EXISTS group_invites (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_group ON group_invites (group_id);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  category_id TEXT,
  name        TEXT NOT NULL,
  topic       TEXT,
  type        TEXT NOT NULL DEFAULT 'text',
  position    INTEGER NOT NULL DEFAULT 0,
  is_private  INTEGER NOT NULL DEFAULT 0,
  slowmode    INTEGER NOT NULL DEFAULT 0,
  voice_status TEXT,
  permissions_synced INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels (group_id);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  added_at   BIGINT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  channel_id       TEXT NOT NULL,
  group_id         TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  allow_permissions TEXT NOT NULL DEFAULT '[]',
  deny_permissions  TEXT NOT NULL DEFAULT '[]',
  updated_by       TEXT NOT NULL,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (channel_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_group
  ON channel_permission_overrides (group_id, channel_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'dm',
  name       TEXT,
  icon_url   TEXT,
  dm_key     TEXT UNIQUE,
  owner_id   TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  joined_at       BIGINT NOT NULL,
  closed          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  client_nonce    TEXT,
  channel_id      TEXT,
  conversation_id TEXT,
  author_id       TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL DEFAULT 'user',
  reply_to_id     TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  edited_at       BIGINT,
  expires_at      BIGINT,
  suppress_embeds INTEGER NOT NULL DEFAULT 0,
  deleted_at      BIGINT,
  deleted_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_author_nonce ON messages (author_id, client_nonce);

CREATE TABLE IF NOT EXISTS forum_posts (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  root_message_id TEXT NOT NULL UNIQUE,
  author_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  locked          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  private         INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forum_posts_channel ON forum_posts (channel_id, archived, updated_at);
CREATE TABLE IF NOT EXISTS forum_post_members (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_forum_post_members_user ON forum_post_members (user_id, post_id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT,
  uploader_id TEXT NOT NULL,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  -- Set for voice messages so the player can draw its length before loading.
  duration_ms INTEGER,
  kind        TEXT NOT NULL DEFAULT 'file',
  processing_status TEXT NOT NULL DEFAULT 'pending',
  preview_provider TEXT,
  preview_key TEXT,
  preview_mime TEXT,
  retention_until BIGINT,
  last_scanned_at BIGINT,
  quarantined_at BIGINT,
  derived_provider TEXT,
  derived_key TEXT,
  derived_mime TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions (user_id);

CREATE TABLE IF NOT EXISTS read_states (
  user_id              TEXT NOT NULL,
  target_type          TEXT NOT NULL,
  target_id            TEXT NOT NULL,
  last_read_message_id TEXT,
  last_read_at         BIGINT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  meta        TEXT,
  ip          TEXT,
  previous_hash TEXT,
  entry_hash  TEXT,
  signature_version INTEGER,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_logs (entry_hash);

CREATE TABLE IF NOT EXISTS audit_chain_state (
  id         TEXT PRIMARY KEY,
  head_hash  TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_blocks (
  user_id    TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
