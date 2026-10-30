-- Run exactly once on existing databases; fresh databases use schema.sql.
ALTER TABLE licenses ADD COLUMN warehouse_id TEXT;
ALTER TABLE licenses ADD COLUMN country_code TEXT;
CREATE INDEX IF NOT EXISTS idx_warehouse ON licenses(warehouse_id);
UPDATE licenses SET warehouse_id = 'es-main', country_code = 'ES'
WHERE app_id = 'com.ocr.fastscan';
