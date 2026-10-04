CREATE TABLE IF NOT EXISTS user_access_policies (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 policy TEXT NOT NULL DEFAULT '{}',
 updated_by TEXT REFERENCES users(id),
 updated_at BIGINT NOT NULL
);
ALTER TABLE channels ADD COLUMN created_by TEXT REFERENCES users(id);
UPDATE server_roles SET permissions=substr(permissions,1,length(permissions)-1)||',"sendImages","sendVideos","sendAudio"]'
 WHERE is_default=1 AND permissions LIKE '%"attachFiles"%' AND permissions NOT LIKE '%"sendImages"%';
UPDATE server_roles SET permissions=substr(permissions,1,length(permissions)-1)||',"screenShare"]'
 WHERE is_default=1 AND permissions LIKE '%"video"%' AND permissions NOT LIKE '%"screenShare"%';
