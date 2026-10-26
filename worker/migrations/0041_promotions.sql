-- Quantity breaks and promotions (src/sales.ts priceLine).
--
-- A quantity break takes a further percentage off a line ordered in that
-- quantity or more, after the customer's own price. A promotion is a
-- discount off list, or a promotional price for one SKU, open to every
-- customer between two dates; a line gets the promotion or the customer's
-- own price, whichever is lower. Both are for a SKU, a product line or *,
-- and the most specific one applies.
CREATE TABLE qty_breaks (
  item         TEXT NOT NULL,
  min_qty      INTEGER NOT NULL CHECK (min_qty > 1),
  disc_pct10   INTEGER NOT NULL CHECK (disc_pct10 BETWEEN 1 AND 500),
  updated      TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (item, min_qty)
);

CREATE TABLE promotions (
  id           TEXT PRIMARY KEY,           -- PR001
  description  TEXT NOT NULL,
  item         TEXT NOT NULL,
  disc_pct10   INTEGER NOT NULL DEFAULT 0 CHECK (disc_pct10 BETWEEN 0 AND 900),
  price        INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),  -- a promotional price for a SKU; 0 for a discount
  starts       TEXT NOT NULL,              -- YYYY-MM-DD, UTC, first day
  ends         TEXT NOT NULL,              -- YYYY-MM-DD, last day
  updated      TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);
CREATE INDEX promotions_by_item ON promotions (item, starts);

INSERT INTO counters (name, value) VALUES ('promotion_id', 0);
