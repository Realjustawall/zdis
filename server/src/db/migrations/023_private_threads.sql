CREATE TABLE IF NOT EXISTS forum_post_members (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_forum_post_members_user
  ON forum_post_members (user_id, post_id);

UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["sendVoiceMessages"]'
  ELSE REPLACE(permissions, ']', ',"sendVoiceMessages"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"sendVoiceMessages"%';
