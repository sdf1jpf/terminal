-- Product master file and stock on hand. Products are never deleted, only
-- discontinued, so invoice lines can always name the product they sold.
CREATE TABLE products (
  sku           TEXT PRIMARY KEY,           -- e.g. BRG-6204, up to 10 characters
  description   TEXT NOT NULL,
  unit_price    INTEGER NOT NULL,           -- whole dollars
  on_hand       INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reorder_point INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('A', 'D')),  -- active, discontinued
  version       INTEGER NOT NULL DEFAULT 1,
  updated       TEXT NOT NULL,              -- RFC 3339, UTC
  updated_by    TEXT NOT NULL
);
