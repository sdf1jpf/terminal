-- Purchasing. Products are bought from vendors (simulated suppliers) on
-- purchase orders, sent to them by EDI as 850s. A vendor answers with an
-- 855 acknowledgment and an 856 ship notice; receiving the goods against
-- the PO puts them in stock.
CREATE TABLE vendors (
  id         TEXT PRIMARY KEY,             -- V00001; also its EDI interchange ID
  name       TEXT NOT NULL,
  city       TEXT NOT NULL,
  state      TEXT NOT NULL,
  lead_days  INTEGER NOT NULL DEFAULT 5,   -- days from order to shipment
  status     TEXT NOT NULL CHECK (status IN ('A', 'I'))  -- active, inactive
);

INSERT INTO vendors (id, name, city, state, lead_days, status) VALUES
  ('V00001', 'MIDWEST FASTENER SUPPLY', 'CHICAGO', 'IL', 3, 'A'),
  ('V00002', 'GREAT LAKES BEARING CO', 'TOLEDO', 'OH', 5, 'A'),
  ('V00003', 'ALLIED FLUID POWER', 'MILWAUKEE', 'WI', 7, 'A'),
  ('V00004', 'RIVER CITY STEEL & PALLET', 'PITTSBURGH', 'PA', 4, 'A');

-- Who supplies each product, and what it costs us.
ALTER TABLE products ADD COLUMN vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN unit_cost INTEGER NOT NULL DEFAULT 0;  -- whole dollars

-- The demo products already on file (see seed.sql, which does the same).
UPDATE products SET unit_cost = (unit_price * 6 + 9) / 10 WHERE unit_cost = 0;
UPDATE products SET vendor = CASE substr(sku, 1, 3)
    WHEN 'BLT' THEN 'V00001' WHEN 'SAF' THEN 'V00001' WHEN 'TAP' THEN 'V00001'
    WHEN 'BRG' THEN 'V00002' WHEN 'CHN' THEN 'V00002' WHEN 'GRS' THEN 'V00002'
    WHEN 'HYD' THEN 'V00003' WHEN 'PMP' THEN 'V00003' WHEN 'VLV' THEN 'V00003' WHEN 'MTR' THEN 'V00003'
    WHEN 'STL' THEN 'V00004' WHEN 'PLT' THEN 'V00004' WHEN 'WLD' THEN 'V00004'
    ELSE '' END
  WHERE vendor = '';

-- A purchase order is OPEN (O) while it is being built, SENT (S) once the
-- 850 has gone, ACKNOWLEDGED (A) when the vendor's 855 comes back, IN
-- TRANSIT (T) after its 856, and RECEIVED (R) when every line is in.
CREATE TABLE purchase_orders (
  id          TEXT PRIMARY KEY,            -- PO00001
  vendor_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('O', 'S', 'A', 'T', 'R')),
  total       INTEGER NOT NULL DEFAULT 0,  -- sum of the lines at cost
  origin      TEXT NOT NULL DEFAULT '',    -- the job that raised it, e.g. CUSREORD
  ship_date   TEXT NOT NULL DEFAULT '',    -- YYYY-MM-DD, promised on the 855
  created     TEXT NOT NULL,               -- RFC 3339, UTC
  created_by  TEXT NOT NULL,
  sent        TEXT NOT NULL DEFAULT '',
  received    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX purchase_orders_by_vendor ON purchase_orders (vendor_id, id);

CREATE TABLE po_lines (
  po_id        TEXT NOT NULL,
  line         INTEGER NOT NULL,
  sku          TEXT NOT NULL,
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost    INTEGER NOT NULL,
  received     INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= quantity),
  PRIMARY KEY (po_id, line)
);
CREATE INDEX po_lines_by_sku ON po_lines (sku);

-- Each receipt of goods: what came in, at what cost. The general ledger
-- posts these to inventory and accounts payable.
CREATE TABLE receipts (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id        TEXT NOT NULL,
  line         INTEGER NOT NULL,
  sku          TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL,
  at           TEXT NOT NULL,              -- RFC 3339, UTC
  by           TEXT NOT NULL
);
CREATE INDEX receipts_by_po ON receipts (po_id, seq);

INSERT INTO counters (name, value) VALUES ('po_id', 0);
