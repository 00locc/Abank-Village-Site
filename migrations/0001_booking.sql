-- Abank Village booking system schema

CREATE TABLE IF NOT EXISTS room_types (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  price_ghs    INTEGER NOT NULL CHECK (price_ghs > 0),
  total_rooms  INTEGER NOT NULL CHECK (total_rooms >= 0),
  sort         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

-- Placeholder room counts (total 50). Edit in the admin dashboard.
INSERT OR IGNORE INTO room_types (id, name, price_ghs, total_rooms, sort) VALUES
  ('standard', 'Standard Room',            200, 15, 1),
  ('block-d',  'Block D Room',             250, 12, 2),
  ('block-bc', 'Block B & C Room',         300, 20, 3),
  ('premium',  'Rooms C3 & C9',            350,  2, 4),
  ('suite',    'Room C6 — Family Suite',   400,  1, 5);

CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT NOT NULL UNIQUE,
  room_type_id     TEXT NOT NULL REFERENCES room_types(id),
  check_in         TEXT NOT NULL,               -- YYYY-MM-DD (first night)
  check_out        TEXT NOT NULL,               -- YYYY-MM-DD (departure day, not a night)
  nights           INTEGER NOT NULL,
  rooms            INTEGER NOT NULL,
  guest_name       TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT NOT NULL,
  notes            TEXT,
  price_ghs        INTEGER NOT NULL,            -- nightly price at time of booking
  amount_ghs       INTEGER NOT NULL,            -- total charged, GHS
  provider         TEXT NOT NULL,               -- paystack | paypal | demo
  provider_ref     TEXT,                        -- paystack reference / paypal order id
  pay_currency     TEXT,
  pay_amount_minor INTEGER,                     -- amount actually charged in minor units
  status           TEXT NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment','confirmed','checked_in','completed','cancelled','expired','payment_conflict')),
  payment_status   TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  hold_expires_at  INTEGER NOT NULL,            -- epoch ms; pending holds stop counting after this
  ip               TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_room_dates ON bookings (room_type_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_provider_ref ON bookings (provider_ref);

CREATE TABLE IF NOT EXISTS booking_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id),
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,                    -- system | guest | admin:<email>
  message     TEXT NOT NULL,
  public      INTEGER NOT NULL DEFAULT 1        -- shown to the guest on the status page
);
CREATE INDEX IF NOT EXISTS idx_events_booking ON booking_events (booking_id);

CREATE TABLE IF NOT EXISTS admins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  iterations  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Cedis per 1 US dollar, used to price PayPal (USD) payments. Update in admin.
INSERT OR IGNORE INTO settings (key, value) VALUES ('ghs_per_usd', '15.50');
