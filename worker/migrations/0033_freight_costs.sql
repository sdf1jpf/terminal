-- Freight costs (src/fleet.ts, src/ledger.ts). A parcel or freight
-- carrier's charge is worked out from the CARRIER table when a shipment is
-- packed. A company truck load costs its miles at the truck's cost per
-- mile (fuel, tires, maintenance) and the driver's hours at their rate;
-- when the truck is back the cost is shared over its shipments by weight,
-- and the load records what the carriers would have charged for the same
-- shipments. The month-end journal posts both to the ledger.
ALTER TABLE trucks ADD COLUMN cost_per_mile REAL NOT NULL DEFAULT 1.0;   -- dollars
ALTER TABLE drivers ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 30.0;   -- dollars, with benefits
ALTER TABLE loads ADD COLUMN cost_miles INTEGER NOT NULL DEFAULT 0;      -- whole dollars, once back
ALTER TABLE loads ADD COLUMN cost_labor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN cost_carrier INTEGER NOT NULL DEFAULT 0;    -- what the carriers would have charged
ALTER TABLE shipments ADD COLUMN freight_cost INTEGER NOT NULL DEFAULT 0; -- whole dollars: the carrier's charge, or a share of the truck's

UPDATE trucks SET cost_per_mile = CASE id WHEN 'T01' THEN 0.95 WHEN 'T02' THEN 0.95 WHEN 'T03' THEN 1.45 WHEN 'T04' THEN 0.8 ELSE cost_per_mile END;
UPDATE drivers SET hourly_rate = CASE cdl_class WHEN 'A' THEN 34 WHEN 'B' THEN 29 ELSE 26 END;

-- Shipments already packed for a carrier, at the CARRIER table's default
-- rates.
UPDATE shipments SET freight_cost = CAST(ROUND(CASE carrier WHEN 'UPS' THEN 12.5 + 0.85 * weight WHEN 'FDX' THEN 95 + 0.42 * weight END) AS INTEGER)
WHERE carrier IN ('UPS', 'FDX') AND status IN ('K', 'S');

INSERT INTO gl_accounts (account, name, type) VALUES
  ('2100', 'ACCRUED FREIGHT', 'L'),
  ('2110', 'ACCRUED FLEET COSTS', 'L'),
  ('5200', 'FREIGHT - CARRIERS', 'X'),
  ('5210', 'FREIGHT - COMPANY TRUCK', 'X');
