-- Sales: salespeople, territories and customer pricing (src/sales.ts).
--
-- Each state belongs to a territory, and each territory has a salesperson.
-- A customer is in the territory of its state unless it is assigned to
-- another, and is served by its territory's salesperson unless assigned
-- its own. An invoice records both when it is opened, so sales stay with
-- whoever made them when assignments change later.
--
-- Percentages are kept in tenths: 35 is 3.5%.
CREATE TABLE salespeople (
  id           TEXT PRIMARY KEY,           -- S01
  name         TEXT NOT NULL,
  comm_pct10   INTEGER NOT NULL DEFAULT 0 CHECK (comm_pct10 BETWEEN 0 AND 500),  -- commission on net sales
  status       TEXT NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),           -- active, inactive
  updated      TEXT NOT NULL,              -- RFC 3339, UTC
  updated_by   TEXT NOT NULL
);

CREATE TABLE territories (
  code         TEXT PRIMARY KEY,           -- up to 4 characters, e.g. NE
  name         TEXT NOT NULL,
  salesperson  TEXT NOT NULL DEFAULT '',   -- '' for house accounts
  updated      TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);

CREATE TABLE territory_states (
  state        TEXT PRIMARY KEY,           -- two letter code
  territory    TEXT NOT NULL
);
CREATE INDEX territory_states_by_territory ON territory_states (territory, state);

ALTER TABLE customers ADD COLUMN territory TEXT NOT NULL DEFAULT '';    -- '' for the territory of its state
ALTER TABLE customers ADD COLUMN salesperson TEXT NOT NULL DEFAULT '';  -- '' for its territory's salesperson

-- A customer's pricing agreements. The item is a SKU, a product line (the
-- SKU's prefix, such as BRG) or * for everything; the most specific one
-- that matches a product prices it. Each is either a discount off list or
-- a contract price.
CREATE TABLE customer_pricing (
  customer_id  TEXT NOT NULL,
  item         TEXT NOT NULL,
  disc_pct10   INTEGER NOT NULL DEFAULT 0 CHECK (disc_pct10 BETWEEN 0 AND 900),
  price        INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),           -- whole dollars; 0 when a discount
  updated      TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (customer_id, item)
);

-- The invoice keeps who sold it; each line keeps the list price and the
-- agreement that priced it. unit_price stays the price charged.
ALTER TABLE invoices ADD COLUMN territory TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN salesperson TEXT NOT NULL DEFAULT '';
ALTER TABLE invoice_lines ADD COLUMN list_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_lines ADD COLUMN disc_pct10 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_lines ADD COLUMN price_rule TEXT NOT NULL DEFAULT '';  -- e.g. BRG 10.0%, CONTRACT; '' at list
UPDATE invoice_lines SET list_price = unit_price;

INSERT INTO salespeople (id, name, comm_pct10, status, updated, updated_by) VALUES
  ('S01', 'MARGARET OKAFOR', 40, 'A', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('S02', 'DALE KOWALSKI', 35, 'A', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('S03', 'ROSA DELGADO', 40, 'A', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('S04', 'TOM WHITEHORSE', 30, 'A', '1987-03-14T09:30:00Z', 'IBMUSER');

INSERT INTO territories (code, name, salesperson, updated, updated_by) VALUES
  ('NE', 'NORTHEAST', 'S01', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('MW', 'MIDWEST', 'S02', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('SO', 'SOUTH', 'S03', '1987-03-14T09:30:00Z', 'IBMUSER'),
  ('WE', 'WEST', 'S04', '1987-03-14T09:30:00Z', 'IBMUSER');

INSERT INTO territory_states (state, territory) VALUES
  ('CT', 'NE'), ('DC', 'NE'), ('DE', 'NE'), ('MA', 'NE'), ('MD', 'NE'), ('ME', 'NE'), ('NH', 'NE'), ('NJ', 'NE'),
  ('NY', 'NE'), ('PA', 'NE'), ('RI', 'NE'), ('VT', 'NE'),
  ('IA', 'MW'), ('IL', 'MW'), ('IN', 'MW'), ('KY', 'MW'), ('MI', 'MW'), ('MN', 'MW'), ('MO', 'MW'), ('OH', 'MW'),
  ('WI', 'MW'), ('WV', 'MW'),
  ('AL', 'SO'), ('AR', 'SO'), ('FL', 'SO'), ('GA', 'SO'), ('LA', 'SO'), ('MS', 'SO'), ('NC', 'SO'), ('OK', 'SO'),
  ('SC', 'SO'), ('TN', 'SO'), ('TX', 'SO'), ('VA', 'SO'),
  ('AK', 'WE'), ('AZ', 'WE'), ('CA', 'WE'), ('CO', 'WE'), ('HI', 'WE'), ('ID', 'WE'), ('KS', 'WE'), ('MT', 'WE'),
  ('ND', 'WE'), ('NE', 'WE'), ('NM', 'WE'), ('NV', 'WE'), ('OR', 'WE'), ('SD', 'WE'), ('UT', 'WE'), ('WA', 'WE'),
  ('WY', 'WE');

-- Invoices already on file go to their customer's territory as it is now.
UPDATE invoices SET
  territory = COALESCE((SELECT t.territory FROM customers c JOIN territory_states t ON t.state = c.state WHERE c.id = invoices.customer_id), ''),
  salesperson = COALESCE((SELECT r.salesperson FROM customers c JOIN territory_states t ON t.state = c.state
                          JOIN territories r ON r.code = t.territory WHERE c.id = invoices.customer_id), '');
