-- The system chooses each shipment's carrier when it is packed, from the
-- ship-to, weight and value (routeFor in shipping.ts). route says why.
ALTER TABLE shipments ADD COLUMN route TEXT NOT NULL DEFAULT '';
