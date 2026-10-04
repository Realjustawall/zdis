-- Create referenced parent tables before dependents on both SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS voice_activities (
  channel_id TEXT NOT NULL,
  activity TEXT,
  started_by TEXT,
  state TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (channel_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS e2ee_identities (
  user_id TEXT NOT NULL,
  public_key TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_expressions (
  id TEXT NOT NULL,
  group_id TEXT,
  attachment_id TEXT,
  name TEXT,
  type TEXT,
  created_by TEXT,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_events (
  id TEXT NOT NULL,
  group_id TEXT,
  channel_id TEXT,
  creator_id TEXT,
  name TEXT,
  description TEXT,
  location TEXT,
  starts_at BIGINT,
  ends_at BIGINT,
  status TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT,
  updated_at BIGINT,
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES server_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_boosts (
  id TEXT NOT NULL,
  group_id TEXT,
  user_id TEXT,
  started_at BIGINT,
  expires_at BIGINT,
  cancelled_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_tiers (
  id TEXT NOT NULL,
  group_id TEXT,
  name TEXT,
  description TEXT,
  price_monthly INTEGER NOT NULL DEFAULT 0,
  benefits TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_subscriptions (
  cancelled_at BIGINT,
  id TEXT NOT NULL,
  tier_id TEXT,
  group_id TEXT,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at BIGINT,
  current_period_end BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_timeouts (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  expires_at BIGINT,
  created_by TEXT,
  created_at BIGINT,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS server_bans (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  banned_by TEXT,
  created_at BIGINT,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automod_rules (
  id TEXT NOT NULL,
  group_id TEXT,
  name TEXT,
  trigger_type TEXT,
  trigger_value TEXT,
  action TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_follows (
  source_channel_id TEXT NOT NULL,
  target_channel_id TEXT NOT NULL,
  followed_by TEXT,
  created_at BIGINT,
  PRIMARY KEY (source_channel_id, target_channel_id)
);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT NOT NULL,
  owner_id TEXT,
  name TEXT,
  description TEXT,
  client_id TEXT,
  client_secret_hash TEXT,
  redirect_uris TEXT,
  scopes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (client_id)
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT NOT NULL,
  app_id TEXT,
  user_id TEXT,
  redirect_uri TEXT,
  scopes TEXT,
  expires_at BIGINT,
  used_at BIGINT,
  PRIMARY KEY (code_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT NOT NULL,
  user_id TEXT,
  owner_id TEXT,
  name TEXT,
  description TEXT,
  created_at BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_installations (
  bot_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  installed_by TEXT,
  permissions TEXT,
  role_id TEXT,
  created_at BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bot_id, group_id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slash_commands (
  id TEXT NOT NULL,
  bot_id TEXT,
  group_id TEXT,
  name TEXT,
  description TEXT,
  response_template TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slash_command_permissions (
  command_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at BIGINT,
  PRIMARY KEY (command_id, group_id, target_type, target_id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incoming_webhooks (
  id TEXT NOT NULL,
  owner_id TEXT,
  bot_id TEXT,
  channel_id TEXT,
  name TEXT,
  token_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  last_used_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automod_actions (
  id TEXT NOT NULL,
  group_id TEXT,
  rule_id TEXT,
  user_id TEXT,
  channel_id TEXT,
  action TEXT,
  matched_value TEXT,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT NOT NULL,
  user_id TEXT,
  endpoint TEXT,
  p256dh TEXT,
  auth TEXT,
  created_at BIGINT,
  last_used_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (endpoint),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_activities (
  user_id TEXT NOT NULL,
  type TEXT,
  name TEXT,
  details TEXT,
  state TEXT,
  started_at BIGINT,
  expires_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_transcript_segments (
  id TEXT NOT NULL,
  channel_id TEXT,
  participant_id TEXT,
  text TEXT,
  language TEXT,
  started_at BIGINT,
  ended_at BIGINT,
  confidence REAL,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_lobby (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT,
  requested_at BIGINT,
  decided_at BIGINT,
  decided_by TEXT,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_consents (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recording INTEGER NOT NULL DEFAULT 0,
  transcript INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stage_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT,
  requested_at BIGINT,
  updated_by TEXT,
  updated_at BIGINT,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_recordings (
  id TEXT NOT NULL,
  channel_id TEXT,
  egress_id TEXT,
  started_by TEXT,
  status TEXT,
  storage_key TEXT,
  started_at BIGINT,
  ended_at BIGINT,
  error TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_quality_samples (
  id TEXT NOT NULL,
  channel_id TEXT,
  user_id TEXT,
  quality TEXT,
  rtt_ms REAL,
  jitter_ms REAL,
  packet_loss REAL,
  bitrate_kbps REAL,
  region TEXT,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_rooms (
  channel_id TEXT NOT NULL,
  host_id TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  lobby_enabled INTEGER NOT NULL DEFAULT 0,
  recording_consent_required INTEGER NOT NULL DEFAULT 0,
  preferred_region TEXT,
  PRIMARY KEY (channel_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS e2ee_migration_backups (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  encrypted_original TEXT,
  created_at BIGINT,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE IF NOT EXISTS notification_dead_letters (
  resolved_by TEXT,
  id TEXT NOT NULL,
  job_type TEXT,
  job_id TEXT,
  payload TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'failed',
  first_failed_at BIGINT,
  last_failed_at BIGINT,
  resolved_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS message_drafts (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT,
  reply_to_id TEXT,
  attachment_ids TEXT,
  updated_at BIGINT,
  PRIMARY KEY (user_id, target_type, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  attempts INTEGER NOT NULL DEFAULT 0,
  id TEXT NOT NULL,
  user_id TEXT,
  target_type TEXT,
  target_id TEXT,
  content TEXT,
  reply_to_id TEXT,
  attachment_ids TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  send_at BIGINT,
  expires_at BIGINT,
  status TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  sent_at BIGINT,
  message_id TEXT,
  error TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT NOT NULL,
  message_id TEXT,
  creator_id TEXT,
  question TEXT,
  multiple INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  exam_mode INTEGER NOT NULL DEFAULT 0,
  closes_at BIGINT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (message_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT NOT NULL,
  poll_id TEXT,
  label TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_correct INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT,
  PRIMARY KEY (poll_id, option_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at BIGINT,
  PRIMARY KEY (user_id, message_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log_redactions (
  audit_log_id TEXT NOT NULL,
  redacted_by TEXT,
  reason TEXT,
  created_at BIGINT,
  PRIMARY KEY (audit_log_id)
);

CREATE TABLE IF NOT EXISTS backup_runs (
  checksum TEXT,
  location TEXT,
  id TEXT NOT NULL,
  provider TEXT,
  status TEXT,
  started_at BIGINT,
  finished_at BIGINT,
  archive_key TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS category_permission_overrides (
  category_id TEXT NOT NULL,
  group_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  allow_permissions TEXT,
  deny_permissions TEXT,
  updated_by TEXT,
  updated_at BIGINT,
  PRIMARY KEY (category_id, target_type, target_id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS e2ee_key_escrows (
  user_id TEXT NOT NULL,
  encrypted_private_key TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT NOT NULL,
  user_id TEXT,
  provider TEXT,
  subject TEXT,
  email INTEGER NOT NULL DEFAULT 1,
  profile TEXT,
  created_at BIGINT,
  last_login_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (provider, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT NOT NULL,
  user_id TEXT,
  name TEXT,
  key_prefix TEXT,
  key_hash TEXT,
  scopes TEXT,
  expires_at BIGINT,
  created_at BIGINT,
  last_used_at BIGINT,
  revoked_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (key_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  id TEXT NOT NULL,
  owner_id TEXT,
  group_id TEXT,
  permission_level TEXT,
  target_type TEXT,
  target_id TEXT,
  name TEXT,
  endpoint TEXT,
  events TEXT,
  secret_encrypted TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  circuit_open_until TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  completed_at BIGINT,
  id TEXT NOT NULL,
  webhook_id TEXT,
  event_id TEXT,
  event_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status TEXT,
  response_body TEXT,
  error TEXT,
  delivered_at BIGINT,
  next_attempt_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (webhook_id) REFERENCES outgoing_webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  event_type TEXT,
  entity_id TEXT,
  payload TEXT,
  created_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS message_expressions (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT NOT NULL,
  message_id TEXT,
  reporter_id TEXT,
  reason TEXT,
  details TEXT,
  status TEXT,
  priority TEXT,
  sla_due_at BIGINT,
  created_at BIGINT,
  updated_at BIGINT,
  assigned_to TEXT,
  resolution TEXT,
  resolved_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moderation_evidence (
  id TEXT NOT NULL,
  report_id TEXT,
  message_id TEXT,
  author_id TEXT,
  content TEXT,
  attachments TEXT,
  evidence_hash TEXT,
  captured_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_reports (
  id TEXT NOT NULL,
  reported_user_id TEXT,
  reporter_id TEXT,
  reason TEXT,
  details TEXT,
  status TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  assigned_to TEXT,
  resolution TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT NOT NULL,
  target_user_id TEXT,
  actor_id TEXT,
  action TEXT,
  reason TEXT,
  expires_at BIGINT,
  created_at BIGINT,
  revoked_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id TEXT NOT NULL,
  action_id TEXT,
  user_id TEXT,
  reason TEXT,
  status TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  reviewer_id TEXT,
  decision TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT NOT NULL,
  user_id TEXT,
  type TEXT,
  title TEXT,
  body TEXT,
  data TEXT,
  created_at BIGINT,
  read_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_digest_items (
  id TEXT NOT NULL,
  user_id TEXT,
  notification_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT,
  delivered_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 1,
  push INTEGER NOT NULL DEFAULT 1,
  mentions INTEGER NOT NULL DEFAULT 1,
  direct_messages INTEGER NOT NULL DEFAULT 1,
  moderation INTEGER NOT NULL DEFAULT 1,
  quiet_start TEXT,
  quiet_end TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  digest_frequency TEXT NOT NULL DEFAULT 'immediate',
  digest_hour TEXT,
  updated_at BIGINT,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_channel_preferences (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'all',
  email INTEGER NOT NULL DEFAULT 1,
  push INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT,
  PRIMARY KEY (user_id, target_type, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT NOT NULL,
  user_id TEXT,
  code_hash TEXT,
  created_at BIGINT,
  used_at BIGINT,
  PRIMARY KEY (id),
  UNIQUE (user_id, code_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resumable_uploads (
  id TEXT NOT NULL,
  user_id TEXT,
  reservation_id TEXT,
  filename TEXT,
  declared_mime TEXT,
  total_size INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  expected_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  expires_at BIGINT,
  created_at BIGINT,
  updated_at BIGINT,
  attachment_id TEXT,
  completed_at BIGINT,
  error TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resumable_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at BIGINT,
  PRIMARY KEY (upload_id, part_number),
  FOREIGN KEY (upload_id) REFERENCES resumable_uploads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  created_by TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS custom_role_capabilities (
  role_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (role_id, capability),
  FOREIGN KEY (role_id) REFERENCES custom_roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_custom_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  granted_by TEXT,
  created_at BIGINT,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES custom_roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT NOT NULL,
  user_id TEXT,
  event TEXT,
  severity TEXT,
  ip TEXT,
  user_agent TEXT,
  meta TEXT,
  created_at BIGINT,
  acknowledged_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_quotas (
  user_id TEXT NOT NULL,
  limit_bytes INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT NOT NULL,
  user_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  expires_at BIGINT,
  created_at BIGINT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_voice_activities_channel_id ON voice_activities (channel_id);

CREATE INDEX IF NOT EXISTS idx_voice_activities_created_at ON voice_activities (created_at);

CREATE INDEX IF NOT EXISTS idx_e2ee_identities_user_id ON e2ee_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_e2ee_identities_created_at ON e2ee_identities (created_at);

CREATE INDEX IF NOT EXISTS idx_group_expressions_group_id ON group_expressions (group_id);

CREATE INDEX IF NOT EXISTS idx_group_expressions_created_at ON group_expressions (created_at);

CREATE INDEX IF NOT EXISTS idx_server_events_group_id ON server_events (group_id);

CREATE INDEX IF NOT EXISTS idx_server_events_channel_id ON server_events (channel_id);

CREATE INDEX IF NOT EXISTS idx_server_events_created_at ON server_events (created_at);

CREATE INDEX IF NOT EXISTS idx_event_rsvps_user_id ON event_rsvps (user_id);

CREATE INDEX IF NOT EXISTS idx_server_boosts_user_id ON server_boosts (user_id);

CREATE INDEX IF NOT EXISTS idx_server_boosts_group_id ON server_boosts (group_id);

CREATE INDEX IF NOT EXISTS idx_subscription_tiers_group_id ON subscription_tiers (group_id);

CREATE INDEX IF NOT EXISTS idx_subscription_tiers_created_at ON subscription_tiers (created_at);

CREATE INDEX IF NOT EXISTS idx_server_subscriptions_user_id ON server_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_server_subscriptions_group_id ON server_subscriptions (group_id);

CREATE INDEX IF NOT EXISTS idx_server_timeouts_user_id ON server_timeouts (user_id);

CREATE INDEX IF NOT EXISTS idx_server_timeouts_group_id ON server_timeouts (group_id);

CREATE INDEX IF NOT EXISTS idx_server_timeouts_created_at ON server_timeouts (created_at);

CREATE INDEX IF NOT EXISTS idx_server_bans_user_id ON server_bans (user_id);

CREATE INDEX IF NOT EXISTS idx_server_bans_group_id ON server_bans (group_id);

CREATE INDEX IF NOT EXISTS idx_server_bans_created_at ON server_bans (created_at);

CREATE INDEX IF NOT EXISTS idx_automod_rules_group_id ON automod_rules (group_id);

CREATE INDEX IF NOT EXISTS idx_automod_rules_created_at ON automod_rules (created_at);

CREATE INDEX IF NOT EXISTS idx_channel_follows_created_at ON channel_follows (created_at);

CREATE INDEX IF NOT EXISTS idx_oauth_apps_created_at ON oauth_apps (created_at);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_user_id ON oauth_authorization_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_bot_installations_group_id ON bot_installations (group_id);

CREATE INDEX IF NOT EXISTS idx_bot_installations_created_at ON bot_installations (created_at);

CREATE INDEX IF NOT EXISTS idx_slash_commands_group_id ON slash_commands (group_id);

CREATE INDEX IF NOT EXISTS idx_slash_commands_created_at ON slash_commands (created_at);

CREATE INDEX IF NOT EXISTS idx_slash_command_permissions_group_id ON slash_command_permissions (group_id);

CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_channel_id ON incoming_webhooks (channel_id);

CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_created_at ON incoming_webhooks (created_at);

CREATE INDEX IF NOT EXISTS idx_automod_actions_user_id ON automod_actions (user_id);

CREATE INDEX IF NOT EXISTS idx_automod_actions_group_id ON automod_actions (group_id);

CREATE INDEX IF NOT EXISTS idx_automod_actions_channel_id ON automod_actions (channel_id);

CREATE INDEX IF NOT EXISTS idx_automod_actions_created_at ON automod_actions (created_at);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created_at ON push_subscriptions (created_at);

CREATE INDEX IF NOT EXISTS idx_user_activities_user_id ON user_activities (user_id);

CREATE INDEX IF NOT EXISTS idx_call_transcript_segments_channel_id ON call_transcript_segments (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_transcript_segments_created_at ON call_transcript_segments (created_at);

CREATE INDEX IF NOT EXISTS idx_call_lobby_user_id ON call_lobby (user_id);

CREATE INDEX IF NOT EXISTS idx_call_lobby_channel_id ON call_lobby (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_consents_user_id ON call_consents (user_id);

CREATE INDEX IF NOT EXISTS idx_call_consents_channel_id ON call_consents (channel_id);

CREATE INDEX IF NOT EXISTS idx_stage_members_user_id ON stage_members (user_id);

CREATE INDEX IF NOT EXISTS idx_stage_members_channel_id ON stage_members (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_recordings_channel_id ON call_recordings (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_quality_samples_user_id ON call_quality_samples (user_id);

CREATE INDEX IF NOT EXISTS idx_call_quality_samples_channel_id ON call_quality_samples (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_quality_samples_created_at ON call_quality_samples (created_at);

CREATE INDEX IF NOT EXISTS idx_call_rooms_channel_id ON call_rooms (channel_id);

CREATE INDEX IF NOT EXISTS idx_call_rooms_created_at ON call_rooms (created_at);

CREATE INDEX IF NOT EXISTS idx_e2ee_migration_backups_created_at ON e2ee_migration_backups (created_at);

CREATE INDEX IF NOT EXISTS idx_message_drafts_user_id ON message_drafts (user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user_id ON scheduled_messages (user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_created_at ON scheduled_messages (created_at);

CREATE INDEX IF NOT EXISTS idx_polls_created_at ON polls (created_at);

CREATE INDEX IF NOT EXISTS idx_poll_options_created_at ON poll_options (created_at);

CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes (user_id);

CREATE INDEX IF NOT EXISTS idx_poll_votes_created_at ON poll_votes (created_at);

CREATE INDEX IF NOT EXISTS idx_saved_messages_user_id ON saved_messages (user_id);

CREATE INDEX IF NOT EXISTS idx_saved_messages_created_at ON saved_messages (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_redactions_created_at ON audit_log_redactions (created_at);

CREATE INDEX IF NOT EXISTS idx_category_permission_overrides_group_id ON category_permission_overrides (group_id);

CREATE INDEX IF NOT EXISTS idx_e2ee_key_escrows_user_id ON e2ee_key_escrows (user_id);

CREATE INDEX IF NOT EXISTS idx_e2ee_key_escrows_created_at ON e2ee_key_escrows (created_at);

CREATE INDEX IF NOT EXISTS idx_external_identities_user_id ON external_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_external_identities_created_at ON external_identities (created_at);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys (created_at);

CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots (user_id);

CREATE INDEX IF NOT EXISTS idx_bots_created_at ON bots (created_at);

CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_group_id ON outgoing_webhooks (group_id);

CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_created_at ON outgoing_webhooks (created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries (created_at);

CREATE INDEX IF NOT EXISTS idx_sync_events_created_at ON sync_events (created_at);

CREATE INDEX IF NOT EXISTS idx_message_reports_created_at ON message_reports (created_at);

CREATE INDEX IF NOT EXISTS idx_user_reports_created_at ON user_reports (created_at);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_created_at ON moderation_actions (created_at);

CREATE INDEX IF NOT EXISTS idx_moderation_appeals_user_id ON moderation_appeals (user_id);

CREATE INDEX IF NOT EXISTS idx_moderation_appeals_created_at ON moderation_appeals (created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);

CREATE INDEX IF NOT EXISTS idx_notification_digest_items_user_id ON notification_digest_items (user_id);

CREATE INDEX IF NOT EXISTS idx_notification_digest_items_created_at ON notification_digest_items (created_at);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences (user_id);

CREATE INDEX IF NOT EXISTS idx_notification_channel_preferences_user_id ON notification_channel_preferences (user_id);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_created_at ON recovery_codes (created_at);

CREATE INDEX IF NOT EXISTS idx_resumable_uploads_user_id ON resumable_uploads (user_id);

CREATE INDEX IF NOT EXISTS idx_resumable_uploads_created_at ON resumable_uploads (created_at);

CREATE INDEX IF NOT EXISTS idx_resumable_parts_created_at ON resumable_parts (created_at);

CREATE INDEX IF NOT EXISTS idx_custom_roles_created_at ON custom_roles (created_at);

CREATE INDEX IF NOT EXISTS idx_user_custom_roles_user_id ON user_custom_roles (user_id);

CREATE INDEX IF NOT EXISTS idx_user_custom_roles_created_at ON user_custom_roles (created_at);

CREATE INDEX IF NOT EXISTS idx_security_events_user_id ON security_events (user_id);

CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events (created_at);

CREATE INDEX IF NOT EXISTS idx_storage_quotas_user_id ON storage_quotas (user_id);

CREATE INDEX IF NOT EXISTS idx_storage_reservations_user_id ON storage_reservations (user_id);

CREATE INDEX IF NOT EXISTS idx_storage_reservations_created_at ON storage_reservations (created_at);
