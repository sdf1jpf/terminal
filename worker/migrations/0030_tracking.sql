-- Shipment tracking. Once a shipment has gone, its carrier is asked where
-- it is (src/tracking.ts): every carrier scan lands in tracking_events, and
-- the shipment carries the latest delivery status, the promised date and,
-- once delivered, when and who signed for it.
ALTER TABLE shipments ADD COLUMN delivery TEXT NOT NULL DEFAULT '';   -- '' not tracked yet, T in transit, O out for delivery, D delivered, X exception
ALTER TABLE shipments ADD COLUMN eta TEXT NOT NULL DEFAULT '';        -- promised delivery date, YYYY-MM-DD
ALTER TABLE shipments ADD COLUMN delivered TEXT NOT NULL DEFAULT '';  -- RFC 3339, UTC
ALTER TABLE shipments ADD COLUMN signed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE shipments ADD COLUMN tracked TEXT NOT NULL DEFAULT '';    -- when the carrier was last asked
CREATE INDEX shipments_to_track ON shipments (status, delivery, tracked);

CREATE TABLE tracking_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id  TEXT NOT NULL,
  at           TEXT NOT NULL,              -- when the carrier scanned it, RFC 3339, UTC
  code         TEXT NOT NULL,              -- LABEL, PICKUP, DEPART, ARRIVE, OUTDLVY, DELIVERED, EXCEPTION
  location     TEXT NOT NULL DEFAULT '',   -- CITY, ST
  detail       TEXT NOT NULL DEFAULT '',
  UNIQUE (shipment_id, at, code)
);
CREATE INDEX tracking_events_by_shipment ON tracking_events (shipment_id, at);

-- Out for delivery, delivered or held up: the order's lifecycle looks again,
-- so the milestone lands on its timeline.
CREATE TRIGGER shipment_delivery AFTER UPDATE OF delivery ON shipments WHEN NEW.delivery <> OLD.delivery AND NEW.delivery IN ('O', 'D', 'X') BEGIN
  INSERT INTO order_signals (kind, ref, what) VALUES ('I', NEW.invoice_id,
    CASE NEW.delivery WHEN 'O' THEN 'OUT FOR DELIVERY' WHEN 'D' THEN 'DELIVERED' ELSE 'DELIVERY EXCEPTION' END);
END;

-- A shipment cancelled before it went never had any; one deleted with its
-- history takes its scans with it.
CREATE TRIGGER shipment_untracked AFTER DELETE ON shipments BEGIN
  DELETE FROM tracking_events WHERE shipment_id = OLD.id;
END;

-- Shipments already on their way start being tracked on the next minute.
UPDATE shipments SET delivery = 'T' WHERE status = 'S';
