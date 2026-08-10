INSERT INTO server_roles
  (id, group_id, name, color, position, permissions, is_default, hoist, mentionable,
   created_by, created_at, updated_at)
SELECT
  g.id,
  g.id,
  '@everyone',
  NULL,
  0,
  '["viewChannel","sendMessages","embedLinks","attachFiles","addReactions","readMessageHistory","sendMessagesInThreads","createPublicThreads","connectVoice","speak","video","useVoiceActivity","requestToSpeak","sendPolls"]',
  1,
  0,
  0,
  g.owner_id,
  g.created_at,
  g.updated_at
FROM chat_groups g
WHERE NOT EXISTS (
  SELECT 1 FROM server_roles r WHERE r.group_id = g.id AND r.is_default = 1
);
