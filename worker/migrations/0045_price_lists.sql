-- Price lists (src/sales.ts priceList). CUSPRICE files a price list in the
-- archive for each customer with pricing agreements or that trades by EDI,
-- and sends each EDI customer its prices as an 832 price/sales catalog, on
-- the first of the month after the new month's promotions have started.
INSERT INTO schedules (name, cron, enabled, updated, updated_by) VALUES
  ('CUSPRICE', '0 5 1 * *', 1, '2026-10-26T00:00:00Z', 'IBMUSER');
