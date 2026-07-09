CREATE TABLE IF NOT EXISTS licenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    app_id      TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    is_active   INTEGER DEFAULT 1,
    is_trial    INTEGER DEFAULT 0,   -- 1=триал, 0=полная лицензия
    expires_at  INTEGER,             -- unix timestamp, NULL = бессрочно
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token  ON licenses(token);
CREATE INDEX IF NOT EXISTS idx_device ON licenses(device_id, app_id);
CREATE INDEX IF NOT EXISTS idx_email  ON licenses(email);
