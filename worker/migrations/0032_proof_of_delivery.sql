-- Proof of delivery for the company truck (src/fleet.ts). The driver
-- signs off each stop: delivered, with who signed and how many cartons
-- they took, or not delivered, with why. A stop not delivered comes back
-- to the warehouse and its shipment waits for another load, so a shipment
-- can be on several loads, but on only one stop that is not an exception.
ALTER TABLE load_stops ADD COLUMN pod_status TEXT NOT NULL DEFAULT '';   -- '' not yet, D delivered, X not delivered
ALTER TABLE load_stops ADD COLUMN pod_at TEXT NOT NULL DEFAULT '';       -- RFC 3339, UTC
ALTER TABLE load_stops ADD COLUMN pod_signed TEXT NOT NULL DEFAULT '';   -- who signed for it
ALTER TABLE load_stops ADD COLUMN pod_cartons INTEGER NOT NULL DEFAULT 0; -- cartons they took
ALTER TABLE load_stops ADD COLUMN pod_note TEXT NOT NULL DEFAULT '';     -- short, damaged, or why it was not delivered
ALTER TABLE load_stops ADD COLUMN pod_by TEXT NOT NULL DEFAULT '';       -- who entered it

DROP INDEX load_stops_by_shipment;
CREATE UNIQUE INDEX load_stops_by_shipment ON load_stops (shipment_id) WHERE pod_status <> 'X';
CREATE INDEX load_stops_redeliver ON load_stops (shipment_id, pod_status);

-- Stops already signed off by hand from the tracking screen.
UPDATE load_stops SET pod_status = 'D',
  pod_at = (SELECT delivered FROM shipments WHERE id = load_stops.shipment_id),
  pod_signed = (SELECT signed_by FROM shipments WHERE id = load_stops.shipment_id),
  pod_cartons = cartons, pod_by = 'CONVERT'
WHERE EXISTS (SELECT 1 FROM shipments WHERE id = load_stops.shipment_id AND delivery = 'D');
