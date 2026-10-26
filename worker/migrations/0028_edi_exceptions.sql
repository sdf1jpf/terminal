-- EDI exceptions: lines of a customer's 850 whose product is missing, not
-- on file or discontinued. The rest of the order becomes an invoice; these
-- wait for an operator to correct (C), drop (D) or reject the order (X).
-- The invoice cannot be released to the warehouse while one is open.
CREATE TABLE edi_exceptions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  edi_id         TEXT NOT NULL,              -- the 850
  invoice_id     TEXT NOT NULL,
  customer_id    TEXT NOT NULL,
  po_number      TEXT NOT NULL,
  po_line        TEXT NOT NULL,              -- the PO1 line number, as sent
  sku            TEXT NOT NULL DEFAULT '',   -- as sent
  quantity       INTEGER NOT NULL,
  unit_price     INTEGER NOT NULL DEFAULT 0, -- as sent
  problem        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('O', 'C', 'D', 'X')),  -- open, corrected, dropped, order rejected
  corrected_sku  TEXT NOT NULL DEFAULT '',
  line           INTEGER,                    -- the invoice line a correction became
  created        TEXT NOT NULL,              -- RFC 3339, UTC
  resolved       TEXT NOT NULL DEFAULT '',
  resolved_by    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX edi_exceptions_by_status ON edi_exceptions (status, seq);
CREATE INDEX edi_exceptions_by_invoice ON edi_exceptions (invoice_id);

-- The invoice's lifecycle waits for its held lines (lifecycle.ts).
CREATE TRIGGER edi_exception_held AFTER INSERT ON edi_exceptions BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.invoice_id, 'EDI EXCEPTION');
END;
CREATE TRIGGER edi_exception_resolved AFTER UPDATE OF status ON edi_exceptions WHEN NEW.status <> OLD.status BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.invoice_id, 'EDI EXCEPTION ' || CASE NEW.status WHEN 'C' THEN 'CORRECTED' WHEN 'D' THEN 'DROPPED' WHEN 'X' THEN 'REJECTED' ELSE 'REOPENED' END);
END;
