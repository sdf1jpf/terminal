-- Sales quotas and monthly commission statements (src/sales.ts). Each
-- salesperson has a monthly quota of net sales, shown against what they
-- sold on the sales report (option 6.5). CUSCOMM prints each salesperson's
-- commission statement, files it in the archive and mails it, on the
-- first of the month for the month just ended.
ALTER TABLE salespeople ADD COLUMN quota INTEGER NOT NULL DEFAULT 0 CHECK (quota >= 0);  -- monthly, whole dollars

UPDATE salespeople SET quota = CASE id WHEN 'S01' THEN 40000 WHEN 'S02' THEN 50000 WHEN 'S03' THEN 35000 WHEN 'S04' THEN 30000 ELSE 0 END;

INSERT INTO schedules (name, cron, enabled, updated, updated_by) VALUES
  ('CUSCOMM', '0 6 1 * *', 1, '2026-10-26T00:00:00Z', 'IBMUSER');
