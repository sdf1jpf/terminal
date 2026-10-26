-- Stock adjustments: a product added with stock, or a hand edit of its
-- quantity on hand or unit cost on the product screen. Each one records the
-- change in the stock's value at cost, and the ledger journals it (source
-- A:<seq>): a gain is Dr 1300 INVENTORY, Cr 5100 INVENTORY ADJUSTMENTS, a
-- loss the other way round.
CREATE TABLE stock_adjustments (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL,             -- change in on hand, + or -
  old_cost   INTEGER NOT NULL,
  new_cost   INTEGER NOT NULL,
  amount     INTEGER NOT NULL,             -- change in value at cost, whole dollars, + or -
  at         TEXT NOT NULL,                -- RFC 3339, UTC
  by         TEXT NOT NULL
);
CREATE INDEX stock_adjustments_by_sku ON stock_adjustments (sku, seq);

INSERT INTO gl_accounts (account, name, type) VALUES ('5100', 'INVENTORY ADJUSTMENTS', 'X');
