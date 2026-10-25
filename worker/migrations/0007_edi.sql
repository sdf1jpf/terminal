-- Simulated EDI (ANSI X12) with customers' systems. Each row is one
-- interchange, inbound or outbound, with its raw segments. Any customer can
-- trade: its interchange ID is its customer number, and ours is CUSTAPI.
--
--   850 purchase order  in   opens an invoice and takes the stock
--   997 acknowledgment  out  accepts or rejects each inbound interchange
--   810 invoice         out  sent when an invoice that came from an 850 is billed
--   820 remittance      in   marks the invoice it names paid
CREATE TABLE edi (
  id           TEXT PRIMARY KEY,           -- EDI00001
  direction    TEXT NOT NULL CHECK (direction IN ('I', 'O')),
  type         TEXT NOT NULL,              -- transaction set: 850, 997, 810, 820
  partner      TEXT NOT NULL,              -- customer number ('' if unknown)
  control      TEXT NOT NULL,              -- the ISA13 interchange control number
  status       TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'SENT')),
  reference    TEXT NOT NULL DEFAULT '',   -- PO and invoice, e.g. INV00012
  note         TEXT NOT NULL DEFAULT '',   -- why it was rejected
  raw          TEXT NOT NULL,              -- the X12 interchange
  created      TEXT NOT NULL,              -- RFC 3339, UTC
  created_by   TEXT NOT NULL
);
CREATE INDEX edi_by_partner ON edi (partner, id);

INSERT INTO counters (name, value) VALUES ('edi_id', 0);
