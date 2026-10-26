-- Freight operations: the company's own trucks and drivers, and the loads
-- they run (src/fleet.ts). Shipments routed to the company truck (TRK) are
-- grouped each day into loads by weight and direction from the warehouse,
-- each with a truck, a driver and a stop sequence. Dispatching a load ships
-- its shipments; the truck's return closes it and adds its miles.
CREATE TABLE trucks (
  id            TEXT PRIMARY KEY,          -- T01
  name          TEXT NOT NULL,             -- 26 FT BOX - INTERNATIONAL MV
  plate         TEXT NOT NULL DEFAULT '',
  capacity_lb   INTEGER NOT NULL,          -- payload
  cdl_class     TEXT NOT NULL CHECK (cdl_class IN ('A', 'B', 'C')),  -- the license it takes to drive it
  odometer      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('A', 'S', 'R')),  -- active, in the shop, retired
  service_miles INTEGER NOT NULL DEFAULT 0, -- the odometer reading the next service is due at
  service_due   TEXT NOT NULL DEFAULT '',  -- or this date, YYYY-MM-DD, whichever comes first
  version       INTEGER NOT NULL DEFAULT 1,
  updated       TEXT NOT NULL,
  updated_by    TEXT NOT NULL
);

CREATE TABLE drivers (
  id            TEXT PRIMARY KEY,          -- D01
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  cdl_class     TEXT NOT NULL CHECK (cdl_class IN ('A', 'B', 'C')),
  cdl_expires   TEXT NOT NULL,             -- YYYY-MM-DD
  status        TEXT NOT NULL CHECK (status IN ('A', 'O', 'L')),  -- available, off, on leave
  version       INTEGER NOT NULL DEFAULT 1,
  updated       TEXT NOT NULL,
  updated_by    TEXT NOT NULL
);

-- A load is one truck's run for a day: P planned, D dispatched (on the
-- road), C complete (back at the warehouse).
CREATE TABLE loads (
  id            TEXT PRIMARY KEY,          -- LD00001
  day           TEXT NOT NULL,             -- YYYY-MM-DD, the warehouse's date
  truck_id      TEXT NOT NULL,
  driver_id     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('P', 'D', 'C')),
  region        TEXT NOT NULL DEFAULT '',  -- NW: MI OH
  miles         INTEGER NOT NULL DEFAULT 0, -- planned, out and back
  drive_min     INTEGER NOT NULL DEFAULT 0, -- planned driving
  duty_min      INTEGER NOT NULL DEFAULT 0, -- planned on duty: driving and unloading
  created       TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  dispatched    TEXT NOT NULL DEFAULT '',
  dispatched_by TEXT NOT NULL DEFAULT '',
  returned      TEXT NOT NULL DEFAULT '',
  actual_miles  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX loads_by_day ON loads (day, status);
-- One run a day for each truck and each driver.
CREATE UNIQUE INDEX loads_by_truck ON loads (truck_id, day);
CREATE UNIQUE INDEX loads_by_driver ON loads (driver_id, day);

-- A load's stops, in the order the truck makes them.
CREATE TABLE load_stops (
  load_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  shipment_id   TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT '',
  weight        INTEGER NOT NULL DEFAULT 0,
  cartons       INTEGER NOT NULL DEFAULT 0,
  leg_miles     INTEGER NOT NULL DEFAULT 0, -- from the stop before, or the warehouse
  eta_min       INTEGER NOT NULL DEFAULT 0, -- planned arrival, minutes after the truck leaves
  PRIMARY KEY (load_id, seq)
);
-- A shipment rides on one load.
CREATE UNIQUE INDEX load_stops_by_shipment ON load_stops (shipment_id);

INSERT INTO counters (name, value) VALUES ('load_id', 0);

-- A shipment cancelled before it went comes off its planned load.
CREATE TRIGGER shipment_unloaded AFTER DELETE ON shipments BEGIN
  DELETE FROM load_stops WHERE shipment_id = OLD.id;
END;

-- The fleet the business starts with.
INSERT INTO trucks (id, name, plate, capacity_lb, cdl_class, odometer, status, service_miles, service_due, updated, updated_by) VALUES
  ('T01', '26 FT BOX - INTERNATIONAL MV', 'OH PFT-1101', 10000, 'B', 84210, 'A', 90000, '2027-01-15', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('T02', '26 FT BOX - FREIGHTLINER M2', 'OH PFT-1102', 10000, 'B', 121940, 'A', 122500, '2026-12-01', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('T03', '53 FT TRACTOR-TRAILER - VOLVO VNL', 'OH PFT-2201', 44000, 'A', 302775, 'A', 310000, '2027-02-10', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('T04', '16 FT STAKE - ISUZU NPR', 'OH PFT-0904', 5500, 'C', 61008, 'S', 61000, '2026-10-20', '2026-10-26T00:00:00Z', 'IBMUSER');

INSERT INTO drivers (id, name, phone, cdl_class, cdl_expires, status, updated, updated_by) VALUES
  ('D01', 'HOLLIS, RAY', '614-555-0141', 'A', '2028-06-30', 'A', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('D02', 'OKAFOR, ADA', '614-555-0177', 'A', '2027-03-31', 'A', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('D03', 'BRANDT, LOU', '614-555-0123', 'B', '2027-09-30', 'A', '2026-10-26T00:00:00Z', 'IBMUSER'),
  ('D04', 'PRUITT, DEE', '614-555-0190', 'B', '2026-12-31', 'O', '2026-10-26T00:00:00Z', 'IBMUSER');
