-- Customer master file.
CREATE TABLE customers (
  id           TEXT PRIMARY KEY,           -- six digits, e.g. 000105
  name         TEXT NOT NULL,
  address      TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL,
  state        TEXT NOT NULL,
  zip          TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  credit_limit INTEGER NOT NULL DEFAULT 0,
  balance      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('A', 'H', 'C')),
  version      INTEGER NOT NULL DEFAULT 1,
  updated      TEXT NOT NULL,              -- RFC 3339, UTC
  updated_by   TEXT NOT NULL
);
CREATE INDEX customers_by_name ON customers (name, id);

-- Next customer number. Incremented atomically by create.
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('customer_id', 0);

-- Logon sessions. Only a SHA-256 of each bearer token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  userid     TEXT NOT NULL,
  expires_at INTEGER NOT NULL              -- Unix milliseconds
);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);
