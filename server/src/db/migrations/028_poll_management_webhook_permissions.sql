ALTER TABLE polls ADD COLUMN creator_id TEXT;
ALTER TABLE polls ADD COLUMN updated_at BIGINT;
UPDATE polls
SET creator_id = (SELECT author_id FROM messages WHERE messages.id = polls.message_id)
WHERE creator_id IS NULL;
UPDATE polls SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE outgoing_webhooks ADD COLUMN group_id TEXT;
ALTER TABLE outgoing_webhooks ADD COLUMN permission_level TEXT NOT NULL DEFAULT 'manageWebhooks';
UPDATE outgoing_webhooks
SET group_id = (SELECT group_id FROM channels WHERE channels.id = outgoing_webhooks.target_id)
WHERE group_id IS NULL AND target_type = 'channel';

CREATE INDEX IF NOT EXISTS idx_webhooks_group ON outgoing_webhooks (group_id, active);
