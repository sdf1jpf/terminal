-- Account activity: invoices and payments posted against a customer.
-- Posting moves the customer's balance, and each row keeps the balance it
-- left behind.
CREATE TABLE transactions (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('I', 'P')),  -- invoice, payment
  amount       INTEGER NOT NULL,           -- whole dollars, always positive
  reference    TEXT NOT NULL DEFAULT '',
  balance      INTEGER NOT NULL,           -- customer balance after posting
  posted       TEXT NOT NULL,              -- RFC 3339, UTC
  posted_by    TEXT NOT NULL
);
CREATE INDEX transactions_by_customer ON transactions (customer_id, seq);

-- Change history: one row per field changed, plus one for each add and
-- delete. Rows outlive the customer they describe.
CREATE TABLE audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('ADD', 'CHANGE', 'DELETE')),
  field        TEXT NOT NULL DEFAULT '',   -- CHANGE only, e.g. CITY
  old_value    TEXT NOT NULL DEFAULT '',
  new_value    TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL,              -- RFC 3339, UTC
  by           TEXT NOT NULL
);
CREATE INDEX audit_by_customer ON audit (customer_id, seq);
