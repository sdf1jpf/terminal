-- Purchase order lifecycles (src/polifecycle.ts): each purchase order gets
-- an OrderLifecycle workflow too, woken by the same outbox as invoices.
CREATE TRIGGER po_opened AFTER INSERT ON purchase_orders BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('P', NEW.id, 'OPENED');
END;
CREATE TRIGGER po_status AFTER UPDATE OF status ON purchase_orders WHEN NEW.status <> OLD.status BEGIN
  INSERT INTO order_signals (kind, ref, what)
    VALUES ('P', NEW.id, CASE NEW.status WHEN 'S' THEN 'SENT' WHEN 'A' THEN 'CONFIRMED' WHEN 'T' THEN 'IN TRANSIT' WHEN 'R' THEN 'RECEIVED' ELSE 'REOPENED' END);
END;
CREATE TRIGGER po_cancelled AFTER DELETE ON purchase_orders BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('P', OLD.id, 'CANCELLED');
END;
CREATE TRIGGER po_receipt AFTER INSERT ON receipts BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('P', NEW.po_id, 'RECEIPT');
END;

-- The purchase orders in flight: their lifecycles pick up where they are.
INSERT INTO order_signals (kind, ref, what) SELECT 'P', id, 'ADOPTED' FROM purchase_orders WHERE status <> 'R' ORDER BY id;
