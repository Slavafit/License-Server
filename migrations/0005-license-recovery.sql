-- Run once on an existing database, before deploying the recovery feature.
-- Fresh databases already include this column in schema.sql.
ALTER TABLE licenses ADD COLUMN recovery_allowed_until INTEGER;
