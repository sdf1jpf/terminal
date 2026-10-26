-- Early-payment terms (src/invoices.ts payInvoice). Every invoice is due
-- in 30 days; a customer can also be offered a discount for paying within
-- a few days of billing, such as 2% 10 NET 30. An invoice keeps the terms
-- it was billed on, and the discount the customer took when it was paid.
-- The discount is on the lines, not the tax. The close journals it to 4100
-- SALES DISCOUNTS: the payment credits the account in full.
ALTER TABLE customers ADD COLUMN early_pct10 INTEGER NOT NULL DEFAULT 0;   -- tenths of a percent
ALTER TABLE customers ADD COLUMN early_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN early_pct10 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN early_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN discount_taken INTEGER NOT NULL DEFAULT 0; -- whole dollars, set when paid

INSERT INTO gl_accounts (account, name, type) VALUES ('4100', 'SALES DISCOUNTS', 'R');
