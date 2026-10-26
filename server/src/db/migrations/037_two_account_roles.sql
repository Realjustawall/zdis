UPDATE users SET role = 'member' WHERE role = 'youtuber';
DELETE FROM user_badges WHERE badge_id IN ('staff', 'developer', 'streamer');
