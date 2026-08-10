UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["sendTtsMessages"]'
  ELSE REPLACE(permissions, ']', ',"sendTtsMessages"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"sendTtsMessages"%';

UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["useEmbeddedActivities"]'
  ELSE REPLACE(permissions, ']', ',"useEmbeddedActivities"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"useEmbeddedActivities"%';

UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["useSoundboard"]'
  ELSE REPLACE(permissions, ']', ',"useSoundboard"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"useSoundboard"%';

UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["useApplicationCommands"]'
  ELSE REPLACE(permissions, ']', ',"useApplicationCommands"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"useApplicationCommands"%';
