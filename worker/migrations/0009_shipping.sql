-- Shipping. Releasing an invoice to the warehouse prints a pick ticket and
-- freezes its lines. The warehouse picks and packs it (PACKED, with cartons
-- and weight) and ships it (SHIPPED, with carrier and tracking number), and
-- a customer who ordered by EDI gets an 856 ship notice. An invoice is
-- billed only after it has shipped.
CREATE TABLE shipments (
  id           TEXT PRIMARY KEY,           -- SHP00001
  invoice_id   TEXT NOT NULL UNIQUE,
  customer_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('P', 'K', 'S')),  -- picking, packed, shipped
  cartons      INTEGER NOT NULL DEFAULT 0,
  weight       INTEGER NOT NULL DEFAULT 0, -- pounds
  carrier      TEXT NOT NULL DEFAULT '',   -- UPS, FDX, TRK
  tracking     TEXT NOT NULL DEFAULT '',
  created      TEXT NOT NULL,              -- RFC 3339, UTC: released to the warehouse
  created_by   TEXT NOT NULL,
  packed       TEXT NOT NULL DEFAULT '',
  shipped      TEXT NOT NULL DEFAULT '',
  shipped_by   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX shipments_by_customer ON shipments (customer_id, id);
CREATE INDEX shipments_by_status ON shipments (status, id);

INSERT INTO counters (name, value) VALUES ('shipment_id', 0);
