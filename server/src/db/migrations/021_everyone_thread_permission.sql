UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["createPublicThreads"]'
  ELSE REPLACE(permissions, ']', ',"createPublicThreads"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"createPublicThreads"%';

UPDATE server_roles
SET permissions = CASE
  WHEN permissions = '[]' THEN '["video"]'
  ELSE REPLACE(permissions, ']', ',"video"]')
END
WHERE is_default = 1
  AND permissions NOT LIKE '%"video"%';
