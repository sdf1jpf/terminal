-- Sales tax on invoices (src/invoices.ts billInvoice). An invoice is taxed
-- when it is billed, at the rate for its ship-to state in the TAXCODE
-- system table, unless its customer holds an exemption certificate. The
-- total is the lines plus the tax, rounded to the dollar; the tax is owed
-- to the state, so the close journals it to 2200 rather than to sales.
ALTER TABLE customers ADD COLUMN tax_exempt TEXT NOT NULL DEFAULT '';  -- exemption certificate number; '' when taxable

ALTER TABLE invoices ADD COLUMN subtotal INTEGER NOT NULL DEFAULT 0;   -- the lines, whole dollars
ALTER TABLE invoices ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_note TEXT NOT NULL DEFAULT '';     -- OH 5.75%, EXEMPT 12-3456, NO TAX IN OR
UPDATE invoices SET subtotal = total;

INSERT INTO gl_accounts (account, name, type) VALUES ('2200', 'SALES TAX PAYABLE', 'L');
