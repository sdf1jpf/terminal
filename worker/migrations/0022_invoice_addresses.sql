-- Bill-to and ship-to addresses on each invoice. A new invoice copies both
-- from the customer, and they can be changed while it is open: the ship-to
-- until it is released to the warehouse, the bill-to until it is billed.
-- Changing the customer's address afterwards leaves its invoices alone.
ALTER TABLE invoices ADD COLUMN bill_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN bill_address TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN bill_city    TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN bill_state   TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN bill_zip     TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ship_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ship_address TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ship_city    TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ship_state   TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ship_zip     TEXT NOT NULL DEFAULT '';

-- Invoices already on file take their customer's address for both.
UPDATE invoices SET
  bill_name    = (SELECT name    FROM customers c WHERE c.id = invoices.customer_id),
  bill_address = (SELECT address FROM customers c WHERE c.id = invoices.customer_id),
  bill_city    = (SELECT city    FROM customers c WHERE c.id = invoices.customer_id),
  bill_state   = (SELECT state   FROM customers c WHERE c.id = invoices.customer_id),
  bill_zip     = (SELECT zip     FROM customers c WHERE c.id = invoices.customer_id)
WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = invoices.customer_id);
UPDATE invoices SET ship_name = bill_name, ship_address = bill_address, ship_city = bill_city,
  ship_state = bill_state, ship_zip = bill_zip;
