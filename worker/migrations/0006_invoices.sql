-- Invoices with line items. An invoice is OPEN while it is being built:
-- lines can be added, changed and removed, and each line holds its stock.
-- Billing it posts the total to the customer's account (an I transaction)
-- and freezes it; marking it paid posts the payment (a P transaction).
CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,           -- INV00001
  customer_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('O', 'B', 'P')),  -- open, billed, paid
  po_number    TEXT NOT NULL DEFAULT '',   -- the customer's purchase order
  total        INTEGER NOT NULL DEFAULT 0, -- sum of the lines, whole dollars
  created      TEXT NOT NULL,              -- RFC 3339, UTC
  created_by   TEXT NOT NULL,
  billed       TEXT NOT NULL DEFAULT '',
  paid         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX invoices_by_customer ON invoices (customer_id, id);

CREATE TABLE invoice_lines (
  invoice_id   TEXT NOT NULL,
  line         INTEGER NOT NULL,
  sku          TEXT NOT NULL,
  description  TEXT NOT NULL,              -- copied from the product when added
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   INTEGER NOT NULL,           -- copied from the product when added
  PRIMARY KEY (invoice_id, line)
);

INSERT INTO counters (name, value) VALUES ('invoice_id', 0);
