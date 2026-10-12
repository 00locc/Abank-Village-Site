-- Guest "My bookings": one-time emailed sign-in links and sessions (no passwords)
CREATE TABLE IF NOT EXISTS guest_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_sessions (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings (email);
