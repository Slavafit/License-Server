-- Additive and safe to run more than once. Existing licenses remain visible.
CREATE TABLE IF NOT EXISTS license_archive (
    license_id INTEGER PRIMARY KEY REFERENCES licenses(id) ON DELETE CASCADE,
    archived_at INTEGER NOT NULL
);
