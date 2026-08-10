CREATE TABLE IF NOT EXISTS message_expressions (
  message_id    TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_message_expressions_attachment
  ON message_expressions (attachment_id, message_id);
