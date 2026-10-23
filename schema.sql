CREATE TABLE IF NOT EXISTS licenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    app_id      TEXT NOT NULL,
    app_name    TEXT DEFAULT '',
    token       TEXT NOT NULL UNIQUE,
    is_active   INTEGER DEFAULT 1,
    is_trial    INTEGER DEFAULT 0,   -- 1=триал, 0=полная лицензия
    expires_at  INTEGER,             -- unix timestamp, NULL = бессрочно
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token  ON licenses(token);
CREATE INDEX IF NOT EXISTS idx_device ON licenses(device_id, app_id);
CREATE INDEX IF NOT EXISTS idx_email  ON licenses(email);

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
