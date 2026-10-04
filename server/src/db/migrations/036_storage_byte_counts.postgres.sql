-- Storage quotas and large uploads exceed PostgreSQL's 32-bit INTEGER range.
-- Widen existing installations as well as freshly migrated databases.
ALTER TABLE storage_quotas ALTER COLUMN limit_bytes TYPE BIGINT;
ALTER TABLE storage_quotas ALTER COLUMN used_bytes TYPE BIGINT;
ALTER TABLE storage_quotas ALTER COLUMN reserved_bytes TYPE BIGINT;
ALTER TABLE storage_reservations ALTER COLUMN bytes TYPE BIGINT;
ALTER TABLE backup_runs ALTER COLUMN bytes TYPE BIGINT;
