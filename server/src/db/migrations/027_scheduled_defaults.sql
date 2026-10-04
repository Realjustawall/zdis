-- Repair defaults for installations which received the original TEXT columns.
UPDATE scheduled_messages SET attempts = 0 WHERE attempts IS NULL;
UPDATE scheduled_messages SET encrypted = 0 WHERE encrypted IS NULL;
