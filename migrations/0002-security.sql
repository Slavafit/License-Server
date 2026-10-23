-- Safe additive migration. It does not update or delete existing licenses.
CREATE TABLE IF NOT EXISTS activation_limits (
    key_hash TEXT NOT NULL,
    bucket   INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (key_hash, bucket)
);

CREATE TABLE IF NOT EXISTS admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    license_id INTEGER,
    actor      TEXT NOT NULL,
    ip_hash    TEXT NOT NULL,
    details    TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit(created_at DESC);
