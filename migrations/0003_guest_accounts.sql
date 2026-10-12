-- Guest accounts: email + password, email confirmed with a 6-digit code
CREATE TABLE IF NOT EXISTS guests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  iterations  INTEGER NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_codes (
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,        -- verify | reset
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
);
DROP TABLE IF EXISTS guest_tokens;
CREATE INDEX IF NOT EXISTS idx_guest_sessions_email ON guest_sessions (email);
