-- Order lifecycles. Each invoice's life, from order to cash, runs as one
-- OrderLifecycle workflow (src/lifecycle.ts) named after the invoice. D1
-- stays the record: the screens read status from the invoice and shipment
-- tables as before, and the workflow reads them too.
--
-- The triggers below drop a signal in the outbox whenever an order changes,
-- however it was changed: a screen, the REST API, an EDI interchange or a
-- batch job. The cron trigger delivers the signals (deliverSignals), starting
-- an order's workflow on its first signal and waking it on the rest.
CREATE TABLE order_signals (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL CHECK (kind IN ('I', 'P')),  -- invoice, purchase order
  ref    TEXT NOT NULL,                               -- INV00001
  what   TEXT NOT NULL,                               -- what changed, for the log
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per order with a lifecycle: where it is and what it waits for.
CREATE TABLE order_flows (
  kind     TEXT NOT NULL CHECK (kind IN ('I', 'P')),
  ref      TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('S', 'W', 'C')),  -- started, waiting, complete
  next     TEXT NOT NULL DEFAULT '',     -- what it waits for, e.g. PAYMENT DUE 2026-11-25
  next_at  TEXT NOT NULL DEFAULT '',     -- when it acts on its own if nothing happens first
  started  TEXT NOT NULL,                -- RFC 3339, UTC
  updated  TEXT NOT NULL,
  ended    TEXT NOT NULL DEFAULT '',
  outcome  TEXT NOT NULL DEFAULT '',     -- PAID, CANCELLED
  PRIMARY KEY (kind, ref)
);

-- The order's timeline, as its workflow saw it happen. Each event is
-- recorded once, so a step that runs again adds nothing.
CREATE TABLE order_timeline (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL CHECK (kind IN ('I', 'P')),
  ref     TEXT NOT NULL,
  event   TEXT NOT NULL,                 -- OPENED, RELEASED, PACKED, SHIPPED, BILLED, REMINDER, PAID ...
  key     TEXT NOT NULL DEFAULT '',      -- tells repeats apart, e.g. the shipment
  at      TEXT NOT NULL,                 -- when it happened, RFC 3339, UTC
  detail  TEXT NOT NULL DEFAULT '',
  amount  INTEGER,
  by      TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, ref, event, key)
);
CREATE INDEX order_timeline_by_ref ON order_timeline (kind, ref, at);

CREATE TRIGGER invoice_opened AFTER INSERT ON invoices BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.id, 'OPENED');
END;
CREATE TRIGGER invoice_status AFTER UPDATE OF status ON invoices WHEN NEW.status <> OLD.status BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.id, CASE NEW.status WHEN 'B' THEN 'BILLED' WHEN 'P' THEN 'PAID' ELSE 'REOPENED' END);
END;
CREATE TRIGGER invoice_cancelled AFTER DELETE ON invoices BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', OLD.id, 'CANCELLED');
END;
CREATE TRIGGER shipment_released AFTER INSERT ON shipments BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.invoice_id, 'RELEASED');
END;
CREATE TRIGGER shipment_status AFTER UPDATE OF status ON shipments WHEN NEW.status <> OLD.status BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.invoice_id, CASE NEW.status WHEN 'K' THEN 'PACKED' WHEN 'S' THEN 'SHIPPED' ELSE 'PICKING' END);
END;
CREATE TRIGGER shipment_cancelled AFTER DELETE ON shipments BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', OLD.invoice_id, 'UNRELEASED');
END;
-- A customer taken off hold may have shipped invoices waiting to be billed.
CREATE TRIGGER customer_active AFTER UPDATE OF status ON customers WHEN NEW.status = 'A' AND OLD.status <> 'A' BEGIN
  INSERT INTO order_signals (kind, ref, what)
    SELECT 'I', id, 'CUSTOMER ACTIVE' FROM invoices WHERE customer_id = NEW.id AND status = 'O';
END;

-- The orders in flight when lifecycles arrived: a signal each starts their
-- workflows, which pick up from wherever the order is.
INSERT INTO order_signals (kind, ref, what) SELECT 'I', id, 'ADOPTED' FROM invoices WHERE status IN ('O', 'B') ORDER BY id;
