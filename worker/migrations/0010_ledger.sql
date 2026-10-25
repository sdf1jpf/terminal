-- Accounts receivable and the general ledger. The month-end close
-- (CUSCLOSE) journals the subledgers into the open period: invoices and
-- payments posted to customers' accounts, the cost of what was billed, and
-- goods received from vendors. It prints the trial balance and closes the
-- period. The dunning run (CUSDUNN) writes to customers with overdue
-- invoices.
CREATE TABLE gl_accounts (
  account  TEXT PRIMARY KEY,               -- 1200
  name     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('A', 'L', 'Q', 'R', 'X'))  -- asset, liability, equity, revenue, expense
);

INSERT INTO gl_accounts (account, name, type) VALUES
  ('1000', 'CASH', 'A'),
  ('1200', 'ACCOUNTS RECEIVABLE', 'A'),
  ('1300', 'INVENTORY', 'A'),
  ('2000', 'ACCOUNTS PAYABLE', 'L'),
  ('3000', 'RETAINED EARNINGS', 'Q'),
  ('4000', 'SALES', 'R'),
  ('5000', 'COST OF GOODS SOLD', 'X');

-- Accounting periods, one per month. Entries go to the open period.
CREATE TABLE gl_periods (
  period     TEXT PRIMARY KEY,             -- YYYY-MM
  status     TEXT NOT NULL CHECK (status IN ('O', 'C')),  -- open, closed
  closed     TEXT NOT NULL DEFAULT '',
  closed_by  TEXT NOT NULL DEFAULT ''
);

-- The journal. Each source row is journaled once: source names it, such as
-- T:12 (transaction 12), C:12 (the cost of the invoice it billed) or R:5
-- (receipt 5), and each entry is one side of a balanced pair.
CREATE TABLE gl_entries (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  period     TEXT NOT NULL,
  account    TEXT NOT NULL,
  debit      INTEGER NOT NULL DEFAULT 0,   -- whole dollars
  credit     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,
  reference  TEXT NOT NULL DEFAULT '',     -- invoice, PO or customer
  memo       TEXT NOT NULL DEFAULT '',
  posted     TEXT NOT NULL,                -- RFC 3339, UTC
  posted_by  TEXT NOT NULL,
  UNIQUE (source, account)
);
CREATE INDEX gl_entries_by_account ON gl_entries (account, period, seq);

-- Dunning letters sent: one per invoice per level, so a level is only
-- ever sent once.
CREATE TABLE dunning (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL,
  invoice_id   TEXT NOT NULL,
  level        INTEGER NOT NULL CHECK (level IN (1, 2, 3)),  -- reminder, second notice, final notice
  days         INTEGER NOT NULL,           -- days past due when sent
  amount       INTEGER NOT NULL,
  sent         TEXT NOT NULL,              -- RFC 3339, UTC
  sent_by      TEXT NOT NULL,
  UNIQUE (invoice_id, level)
);
CREATE INDEX dunning_by_customer ON dunning (customer_id, seq);
