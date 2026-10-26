// Freight operations: the company's trucks and drivers, and the loads they
// run, shared by the REST endpoints (index.ts), the screens
// (screens/fleet.ts, screens/loads.ts) and the batch jobs (jobs.ts).
//
// Shipments the CARRIER table routes to the company truck (TRK) wait,
// packed, to be loaded. planLoads groups a day's into loads: it sweeps
// round the warehouse by compass direction, filling a load until the next
// stop would overfill the biggest free truck or keep the driver out longer
// than a day's hours, then puts each load on the smallest truck it fits
// and a driver licensed for that truck with the hours left this week. The
// stops are put in the order that drives the fewest miles (sequence).
//
// A load goes PLANNED -> DISPATCHED (dispatchLoad ships its shipments and
// they are out for delivery) -> COMPLETE (returnLoad: the truck is back,
// its odometer goes up by the miles). The driver signs off each stop
// (proof of delivery): delivered, with who signed and the cartons taken,
// or not delivered, with why (deliverStop, stopNotDelivered). That is the
// shipment's tracking and lands on the order's timeline; a stop not
// delivered comes back and its shipment waits for another load. A load
// comes back only when every stop is signed off.
//
// Trucks are due for service every SERVICE_MILES or SERVICE_DAYS, whichever
// comes first; a truck that is due, in the shop or retired is not planned.

import { bearing, compass, DEPOT, locate, miles, type Point } from "./geo";
import { HttpError } from "./http";
import { addressOf, type Invoice } from "./invoices";
import type { StepResult } from "./jobs";
import { ship, type Shipment } from "./shipping";
import { syslog } from "./syslog";
import { carrierRates, chooseCarrier, freight } from "./systables";
import { trackShipment, type Scan, type TrackingProvider, type TrackRequest } from "./tracking";

export interface Truck {
	id: string;
	name: string;
	plate: string;
	capacity_lb: number;
	cdl_class: "A" | "B" | "C";
	odometer: number;
	status: "A" | "S" | "R";
	service_miles: number;
	service_due: string; // YYYY-MM-DD
	cost_per_mile: number; // dollars: fuel, tires, maintenance
	version: number;
	updated: string;
	updated_by: string;
}

export interface Driver {
	id: string;
	name: string;
	phone: string;
	cdl_class: "A" | "B" | "C";
	cdl_expires: string; // YYYY-MM-DD
	status: "A" | "O" | "L";
	hourly_rate: number; // dollars, with benefits
	version: number;
	updated: string;
	updated_by: string;
}

export interface Load {
	id: string;
	day: string;
	truck_id: string;
	driver_id: string;
	status: "P" | "D" | "C";
	region: string;
	miles: number;
	drive_min: number;
	duty_min: number;
	created: string;
	created_by: string;
	dispatched: string;
	dispatched_by: string;
	returned: string;
	actual_miles: number;
	cost_miles: number; // whole dollars, once back: the miles at the truck's cost per mile
	cost_labor: number; // ... the driver's hours at their rate
	cost_carrier: number; // ... and what the carriers would have charged for the same shipments
}

export interface Stop {
	load_id: string;
	seq: number;
	shipment_id: string;
	name: string;
	city: string;
	state: string;
	weight: number;
	cartons: number;
	leg_miles: number;
	eta_min: number;
	pod_status: "" | "D" | "X"; // proof of delivery: not yet, delivered, not delivered
	pod_at: string;
	pod_signed: string;
	pod_cartons: number;
	pod_note: string;
	pod_by: string;
}

// StopStatus is a stop with where its shipment stands.
export interface StopStatus extends Stop {
	invoice_id: string;
	customer_id: string;
	ship_status: Shipment["status"];
	delivery: Shipment["delivery"];
	delivered: string;
	signed_by: string;
}

// LoadSummary is a load with its stops counted.
export interface LoadSummary extends Load {
	stops: number;
	delivered: number;
	missed: number; // stops not delivered
	weight: number;
	cartons: number;
}

export const truckStatusNames: Record<string, string> = { A: "ACTIVE", S: "IN SHOP", R: "RETIRED" };
export const driverStatusNames: Record<string, string> = { A: "AVAILABLE", O: "OFF", L: "ON LEAVE" };
export const loadStatusNames: Record<string, string> = { P: "PLANNED", D: "DISPATCHED", C: "COMPLETE" };

// Planning assumptions.
export const MPH = 50; // average road speed, loaded
export const DWELL_MIN = 30; // unloading at each stop
export const PRETRIP_MIN = 30; // inspection and loading before the truck leaves
export const MAX_DRIVE_MIN = 11 * 60; // hours of service: driving in a day
export const MAX_DUTY_MIN = 14 * 60; // ... and on duty
export const WEEK_DUTY_MIN = 60 * 60; // ... and on duty in seven days
export const SERVICE_MILES = 15_000;
export const SERVICE_DAYS = 90;
const SOON_MILES = 500;
const SOON_DAYS = 7;

const DAY_MS = 86_400_000;
const now = () => new Date().toISOString();
const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);

// freightDay is the warehouse's date, in Ohio, for a moment.
export function freightDay(ms = Date.now()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
		.format(new Date(ms));
}

export function addDays(day: string, n: number): string {
	return new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")) && addDays(s, 0) === s;

// dayOf checks a typed date, YYYY-MM-DD, and makes blank today.
export function dayOf(typed: string): string {
	const d = typed.trim();
	if (!d) return freightDay();
	if (!isDay(d)) throw bad("day", "the date must be YYYY-MM-DD");
	return d;
}

// ---- trucks ----

export type ServiceState = "OK" | "SOON" | "DUE";

// serviceState says whether a truck is due for service on a day.
export function serviceState(t: Truck, day = freightDay()): ServiceState {
	if ((t.service_miles > 0 && t.odometer >= t.service_miles) || (t.service_due !== "" && day >= t.service_due)) return "DUE";
	if ((t.service_miles > 0 && t.odometer >= t.service_miles - SOON_MILES) || (t.service_due !== "" && addDays(day, SOON_DAYS) >= t.service_due)) return "SOON";
	return "OK";
}

export async function listTrucks(db: D1Database): Promise<Truck[]> {
	const { results } = await db.prepare("SELECT * FROM trucks ORDER BY id").all<Truck>();
	return results;
}

export async function getTruck(db: D1Database, id: string): Promise<Truck> {
	const t = await db.prepare("SELECT * FROM trucks WHERE id = ?").bind(id.trim().toUpperCase()).first<Truck>();
	if (!t) throw new HttpError(404, "not_found", `truck ${id.toUpperCase()} not found`);
	return t;
}

export type TruckFields = Omit<Truck, "version" | "updated" | "updated_by">;

const ID = /^[A-Z0-9-]{1,8}$/;

function text(v: unknown, field: string, what: string, max: number, required = true): string {
	const s = String(v ?? "").trim().toUpperCase();
	if (required && !s) throw bad(field, `enter the ${what}`);
	if (s.length > max) throw bad(field, `the ${what} is at most ${max} characters`);
	return s;
}

function whole(v: unknown, field: string, what: string, min: number, max: number): number {
	const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v ?? "")) ? Number(v) : NaN;
	if (!Number.isInteger(n) || n < min || n > max) throw bad(field, `the ${what} must be a whole number from ${min} to ${max}`);
	return n;
}

function oneOf(v: unknown, field: string, what: string, names: Record<string, string>): string {
	const s = String(v ?? "").trim().toUpperCase();
	if (!names[s]) throw bad(field, `the ${what} must be ${Object.keys(names).join(", ").replace(/, (\w+)$/, " or $1")}`);
	return s;
}

function dollars(v: unknown, field: string, what: string, min: number, max: number): number {
	const n = typeof v === "number" ? v : /^\s*\d+(\.\d{1,2})?\s*$/.test(String(v ?? "")) ? Number(v) : NaN;
	if (!(n >= min && n <= max)) throw bad(field, `the ${what} must be dollars and cents from ${min} to ${max}`);
	return Math.round(n * 100) / 100;
}

function dateField(v: unknown, field: string, what: string, required: boolean): string {
	const s = String(v ?? "").trim();
	if (!s && !required) return "";
	if (!isDay(s)) throw bad(field, `the ${what} must be a date, YYYY-MM-DD`);
	return s;
}

const classes = { A: "A", B: "B", C: "C" };

export function parseTruck(b: Record<string, unknown>): TruckFields {
	const id = text(b.id, "id", "truck number", 8);
	if (!ID.test(id)) throw bad("id", "the truck number is letters, digits and dashes");
	return {
		id,
		name: text(b.name, "name", "description", 34),
		plate: text(b.plate, "plate", "plate", 12, false),
		capacity_lb: whole(b.capacity_lb, "capacity_lb", "capacity", 500, 80_000),
		cdl_class: oneOf(b.cdl_class, "cdl_class", "license class", classes) as Truck["cdl_class"],
		odometer: whole(b.odometer, "odometer", "odometer", 0, 9_999_999),
		status: oneOf(b.status, "status", "status", truckStatusNames) as Truck["status"],
		service_miles: whole(b.service_miles ?? 0, "service_miles", "service miles", 0, 9_999_999),
		service_due: dateField(b.service_due, "service_due", "service date", false),
		cost_per_mile: dollars(b.cost_per_mile, "cost_per_mile", "cost per mile", 0, 20),
	};
}

// saveTruck adds a truck (version 0) or changes one at the version read.
export async function saveTruck(db: D1Database, user: string, t: TruckFields, version: number): Promise<Truck> {
	if (version === 0) {
		const row = await db.prepare(
			`INSERT INTO trucks (id, name, plate, capacity_lb, cdl_class, odometer, status, service_miles, service_due, cost_per_mile, updated, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING *`,
		).bind(t.id, t.name, t.plate, t.capacity_lb, t.cdl_class, t.odometer, t.status, t.service_miles, t.service_due, t.cost_per_mile, now(), user).first<Truck>();
		if (!row) throw bad("id", `truck ${t.id} is already on file`);
		await syslog(db, user, `CUS1901I TRUCK ${t.id} ADDED: ${t.name}`.slice(0, 120));
		return row;
	}
	const row = await db.prepare(
		`UPDATE trucks SET name = ?2, plate = ?3, capacity_lb = ?4, cdl_class = ?5, odometer = ?6, status = ?7, service_miles = ?8,
		   service_due = ?9, cost_per_mile = ?13, version = version + 1, updated = ?10, updated_by = ?11
		 WHERE id = ?1 AND version = ?12 RETURNING *`,
	).bind(t.id, t.name, t.plate, t.capacity_lb, t.cdl_class, t.odometer, t.status, t.service_miles, t.service_due, now(), user, version, t.cost_per_mile).first<Truck>();
	if (row) return row;
	await getTruck(db, t.id);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

// truckServiced records a service: the next is due SERVICE_MILES on, or
// SERVICE_DAYS from today, and a truck in the shop is back in service.
export async function truckServiced(db: D1Database, user: string, id: string): Promise<Truck> {
	const t = await getTruck(db, id);
	if (t.status === "R") throw bad("status", `truck ${t.id} is retired`);
	const row = await db.prepare(
		`UPDATE trucks SET service_miles = odometer + ?2, service_due = ?3, status = 'A', version = version + 1, updated = ?4, updated_by = ?5
		 WHERE id = ?1 RETURNING *`,
	).bind(t.id, SERVICE_MILES, addDays(freightDay(), SERVICE_DAYS), now(), user).first<Truck>();
	await syslog(db, user, `CUS1902I TRUCK ${t.id} SERVICED AT ${t.odometer} MI, NEXT DUE ${row!.service_miles} MI OR ${row!.service_due}`);
	return row!;
}

// ---- drivers ----

export async function listDrivers(db: D1Database): Promise<Driver[]> {
	const { results } = await db.prepare("SELECT * FROM drivers ORDER BY id").all<Driver>();
	return results;
}

export async function getDriver(db: D1Database, id: string): Promise<Driver> {
	const d = await db.prepare("SELECT * FROM drivers WHERE id = ?").bind(id.trim().toUpperCase()).first<Driver>();
	if (!d) throw new HttpError(404, "not_found", `driver ${id.toUpperCase()} not found`);
	return d;
}

export type DriverFields = Omit<Driver, "version" | "updated" | "updated_by">;

export function parseDriver(b: Record<string, unknown>): DriverFields {
	const id = text(b.id, "id", "driver number", 8);
	if (!ID.test(id)) throw bad("id", "the driver number is letters, digits and dashes");
	return {
		id,
		name: text(b.name, "name", "name", 30),
		phone: text(b.phone, "phone", "phone", 14, false),
		cdl_class: oneOf(b.cdl_class, "cdl_class", "license class", classes) as Driver["cdl_class"],
		cdl_expires: dateField(b.cdl_expires, "cdl_expires", "license expiry", true),
		status: oneOf(b.status, "status", "status", driverStatusNames) as Driver["status"],
		hourly_rate: dollars(b.hourly_rate, "hourly_rate", "hourly rate", 0, 200),
	};
}

export async function saveDriver(db: D1Database, user: string, d: DriverFields, version: number): Promise<Driver> {
	if (version === 0) {
		const row = await db.prepare(
			`INSERT INTO drivers (id, name, phone, cdl_class, cdl_expires, status, hourly_rate, updated, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING *`,
		).bind(d.id, d.name, d.phone, d.cdl_class, d.cdl_expires, d.status, d.hourly_rate, now(), user).first<Driver>();
		if (!row) throw bad("id", `driver ${d.id} is already on file`);
		await syslog(db, user, `CUS1903I DRIVER ${d.id} ADDED: ${d.name}`.slice(0, 120));
		return row;
	}
	const row = await db.prepare(
		`UPDATE drivers SET name = ?2, phone = ?3, cdl_class = ?4, cdl_expires = ?5, status = ?6, hourly_rate = ?10, version = version + 1,
		   updated = ?7, updated_by = ?8
		 WHERE id = ?1 AND version = ?9 RETURNING *`,
	).bind(d.id, d.name, d.phone, d.cdl_class, d.cdl_expires, d.status, now(), user, version, d.hourly_rate).first<Driver>();
	if (row) return row;
	await getDriver(db, d.id);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

// canDrive says whether a license class takes a truck: A drives anything,
// B a B or C truck, C only a C.
export const canDrive = (license: string, truck: string) => license <= truck;

// dutyMinutes is a driver's time on duty in the seven days that end on a
// day: a complete load as it ran, a planned or dispatched one as planned.
export async function dutyMinutes(db: D1Database, driverId: string, day: string, except = ""): Promise<number> {
	const row = await db.prepare(
		`SELECT COALESCE(SUM(CASE WHEN status = 'C' AND returned <> '' AND dispatched <> ''
		   THEN MAX(CAST((julianday(returned) - julianday(dispatched)) * 1440 AS INTEGER), 0) + ?4 ELSE duty_min END), 0) AS m
		 FROM loads WHERE driver_id = ?1 AND day BETWEEN ?2 AND ?3 AND id <> ?5`,
	).bind(driverId, addDays(day, -6), day, PRETRIP_MIN, except).first<{ m: number }>();
	return row!.m;
}

// ---- routes ----

interface Place extends Point {
	weight: number;
}

// sequence orders a load's stops to drive the fewest miles out from the
// warehouse and back: nearest stop first, then any two legs that cross are
// uncrossed (2-opt) until none do.
export function sequence<T extends Point>(stops: T[]): T[] {
	const left = [...stops];
	const route: T[] = [];
	let at: Point = DEPOT;
	while (left.length > 0) {
		let best = 0;
		for (let i = 1; i < left.length; i++) if (miles(at, left[i]) < miles(at, left[best])) best = i;
		at = left.splice(best, 1)[0];
		route.push(at as T);
	}
	const pt = (i: number): Point => (i < 0 || i >= route.length ? DEPOT : route[i]);
	for (let improved = true; improved;) {
		improved = false;
		for (let i = 0; i < route.length - 1; i++) {
			for (let j = i + 1; j < route.length; j++) {
				const before = miles(pt(i - 1), pt(i)) + miles(pt(j), pt(j + 1));
				const after = miles(pt(i - 1), pt(j)) + miles(pt(i), pt(j + 1));
				if (after < before) {
					route.splice(i, j - i + 1, ...route.slice(i, j + 1).reverse());
					improved = true;
				}
			}
		}
	}
	return route;
}

export interface Plan {
	legs: number[]; // miles to each stop from the one before
	eta: number[]; // minutes after leaving to arrive at each stop
	miles: number; // out and back
	drive_min: number;
	duty_min: number;
}

const driveMin = (mi: number) => Math.round((mi / MPH) * 60);

// schedule times a route, its stops in order.
export function schedule(route: Point[]): Plan {
	const legs: number[] = [];
	const eta: number[] = [];
	let at: Point = DEPOT;
	let t = 0;
	for (const p of route) {
		const mi = miles(at, p);
		legs.push(mi);
		t += driveMin(mi);
		eta.push(t);
		t += DWELL_MIN;
		at = p;
	}
	const total = legs.reduce((a, b) => a + b, 0) + (route.length ? miles(at, DEPOT) : 0);
	const drive = driveMin(total);
	return { legs, eta, miles: total, drive_min: drive, duty_min: PRETRIP_MIN + drive + DWELL_MIN * route.length };
}

// region names where a load goes: the compass direction of its stops from
// the warehouse, and their states.
export function region(stops: (Point & { state: string })[]): string {
	if (stops.length === 0) return "";
	let x = 0;
	let y = 0;
	for (const s of stops) {
		const b = (bearing(DEPOT, s) * Math.PI) / 180;
		x += Math.sin(b);
		y += Math.cos(b);
	}
	const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
	const states = [...new Set(stops.map((s) => s.state))].sort().join(" ");
	return `${compass(deg)}: ${states}`.slice(0, 30);
}

// ---- planning ----

// Waiting is a packed company truck shipment not yet on a load.
export interface Waiting extends Place {
	shipment_id: string;
	invoice_id: string;
	customer_id: string;
	name: string;
	city: string;
	state: string;
	cartons: number;
	bearing: number;
	redeliver: boolean; // it came back on an earlier load
}

// waitingShipments returns the packed company truck shipments not on a
// load yet, and those that came back not delivered, oldest first.
export async function waitingShipments(db: D1Database): Promise<Waiting[]> {
	const { results } = await db.prepare(
		`SELECT s.id AS shipment_id, s.invoice_id, s.customer_id, s.weight, s.cartons, s.status AS ship_status, i.*
		 FROM shipments s JOIN invoices i ON i.id = s.invoice_id
		 WHERE s.carrier = 'TRK' AND NOT EXISTS (SELECT 1 FROM load_stops l WHERE l.shipment_id = s.id AND l.pod_status <> 'X')
		   AND (s.status = 'K' OR (s.status = 'S' AND s.delivery = 'X'
		        AND EXISTS (SELECT 1 FROM load_stops l WHERE l.shipment_id = s.id AND l.pod_status = 'X')))
		 ORDER BY s.id`,
	).all<Invoice & { shipment_id: string; invoice_id: string; weight: number; cartons: number; ship_status: string }>();
	return results.map((r) => {
		const to = addressOf(r, "ship");
		const p = locate(to.city, to.state);
		return {
			shipment_id: r.shipment_id, invoice_id: r.invoice_id, customer_id: r.customer_id,
			name: to.name.slice(0, 30), city: to.city.toUpperCase(), state: to.state.toUpperCase(),
			weight: r.weight, cartons: r.cartons, ...p, bearing: bearing(DEPOT, p), redeliver: r.ship_status === "S",
		};
	});
}

export interface Unplanned {
	shipment_id: string;
	reason: string;
}

// freeTrucks returns the trucks that can run on a day: active, not due for
// service and not on another load that day, smallest first.
export async function freeTrucks(db: D1Database, day: string): Promise<Truck[]> {
	const { results } = await db.prepare(
		"SELECT * FROM trucks t WHERE status = 'A' AND NOT EXISTS (SELECT 1 FROM loads WHERE truck_id = t.id AND day = ?) ORDER BY capacity_lb, id",
	).bind(day).all<Truck>();
	return results.filter((t) => serviceState(t, day) !== "DUE");
}

// freeDrivers returns the drivers who can work on a day, with the minutes
// on duty they have left this week, the most first.
export async function freeDrivers(db: D1Database, day: string): Promise<(Driver & { left: number })[]> {
	const { results } = await db.prepare(
		"SELECT * FROM drivers d WHERE status = 'A' AND cdl_expires >= ?1 AND NOT EXISTS (SELECT 1 FROM loads WHERE driver_id = d.id AND day = ?1) ORDER BY id",
	).bind(day).all<Driver>();
	const out = [];
	for (const d of results) out.push({ ...d, left: WEEK_DUTY_MIN - (await dutyMinutes(db, d.id, day)) });
	return out.sort((a, b) => b.left - a.left || a.id.localeCompare(b.id));
}

// daysFor is how many days a route takes within the hours of service.
export function daysFor(p: Plan): number {
	return Math.max(1, Math.ceil(p.drive_min / MAX_DRIVE_MIN), Math.ceil(p.duty_min / MAX_DUTY_MIN));
}

// SECTOR_GAP splits the stops round the warehouse into sectors: two
// directions further apart than this are not on the same road out.
const SECTOR_GAP = 45;

const weightOf = (g: Waiting[]) => g.reduce((t, w) => t + w.weight, 0);

// group sweeps the waiting shipments round the warehouse into loads no
// heavier than capacity. Stops are split into sectors where the directions
// they lie in leave a gap, and each sector is swept into loads that fit
// in a day's driving and duty, or, for a stop too far for a day, in no
// more days than that stop takes on its own. While there are more loads
// than maxLoads (the trucks free), the two neighbouring loads that merge
// for the fewest extra miles are merged, if they fit.
export function group(waiting: Waiting[], capacity: number, maxLoads = Infinity): { loads: Waiting[][]; tooHeavy: Waiting[] } {
	const tooHeavy = waiting.filter((w) => w.weight > capacity);
	const ok = waiting.filter((w) => w.weight <= capacity).sort((a, b) => a.bearing - b.bearing || a.shipment_id.localeCompare(b.shipment_id));
	// Start the sweep after the widest gap between directions, so a load
	// does not straddle it.
	let start = 0;
	let widest = -1;
	ok.forEach((w, i) => {
		const prev = ok[(i + ok.length - 1) % ok.length];
		const gap = (w.bearing - prev.bearing + 360) % 360 || (ok.length === 1 ? 360 : 0);
		if (gap > widest) {
			widest = gap;
			start = i;
		}
	});
	const swept = [...ok.slice(start), ...ok.slice(0, start)];
	const loads: Waiting[][] = [];
	let cur: Waiting[] = [];
	for (const w of swept) {
		const prev = cur[cur.length - 1];
		const sameSector = prev && (w.bearing - prev.bearing + 360) % 360 <= SECTOR_GAP;
		const trial = [...cur, w];
		if (cur.length === 0) cur = trial;
		else if (sameSector && fits(trial, capacity, daysFor(schedule(sequence(cur))))) cur = trial;
		else {
			loads.push(cur);
			cur = [w];
		}
	}
	if (cur.length > 0) loads.push(cur);

	while (loads.length > maxLoads) {
		let best = -1;
		let extra = Infinity;
		for (let i = 0; i + 1 < loads.length; i++) {
			const merged = [...loads[i], ...loads[i + 1]];
			const days = Math.max(daysFor(schedule(sequence(loads[i]))), daysFor(schedule(sequence(loads[i + 1]))));
			if (!fits(merged, capacity, days)) continue;
			const add = schedule(sequence(merged)).miles - schedule(sequence(loads[i])).miles - schedule(sequence(loads[i + 1])).miles;
			if (add < extra) {
				extra = add;
				best = i;
			}
		}
		if (best < 0) break;
		loads.splice(best, 2, [...loads[best], ...loads[best + 1]]);
	}
	return { loads, tooHeavy };
}

function fits(stops: Waiting[], capacity: number, days: number): boolean {
	return weightOf(stops) <= capacity && daysFor(schedule(sequence(stops))) <= days;
}

// planLoads plans a day's loads from the waiting shipments. Shipments that
// cannot go (too heavy for any truck, or no truck or driver left) stay
// waiting, with the reason.
export async function planLoads(db: D1Database, user: string, day: string): Promise<{ loads: Load[]; unplanned: Unplanned[] }> {
	if (day < freightDay()) throw bad("day", `${day} is past - plan today or a later day`);
	const waiting = await waitingShipments(db);
	const trucks = await freeTrucks(db, day);
	const drivers = await freeDrivers(db, day);
	const unplanned: Unplanned[] = [];
	if (waiting.length === 0) return { loads: [], unplanned };
	if (trucks.length === 0) {
		return { loads: [], unplanned: waiting.map((w) => ({ shipment_id: w.shipment_id, reason: "NO TRUCK AVAILABLE" })) };
	}
	const capacity = Math.max(...trucks.map((t) => t.capacity_lb));
	const { loads: groups, tooHeavy } = group(waiting, capacity, trucks.length);
	for (const w of tooHeavy) unplanned.push({ shipment_id: w.shipment_id, reason: `${w.weight} LB - OVER EVERY TRUCK` });

	const made: Load[] = [];
	for (const g of [...groups].sort((a, b) => weightOf(b) - weightOf(a))) {
		const route = sequence(g);
		const plan = schedule(route);
		const ti = trucks.findIndex((t) => t.capacity_lb >= weightOf(g));
		const truck = trucks[ti];
		// The driver with the narrowest license that takes the truck, so
		// those who can drive the big rigs are kept for them.
		let di = -1;
		if (truck) {
			drivers.forEach((d, i) => {
				if (!canDrive(d.cdl_class, truck.cdl_class) || d.left < plan.duty_min) return;
				if (di < 0 || d.cdl_class > drivers[di].cdl_class) di = i;
			});
		}
		if (!truck || di < 0) {
			for (const w of g) unplanned.push({ shipment_id: w.shipment_id, reason: truck ? "NO DRIVER AVAILABLE" : "NO TRUCK AVAILABLE" });
			continue;
		}
		const driver = drivers[di];
		trucks.splice(ti, 1);
		drivers.splice(di, 1);
		made.push(await insertLoad(db, user, day, truck.id, driver.id, route, plan));
	}
	if (made.length > 0) {
		await syslog(db, user, `CUS1904I ${made.length} TRUCK LOAD(S) PLANNED FOR ${day}, ${made.reduce((n, l) => n + l.miles, 0)} MI` +
			(unplanned.length ? `, ${unplanned.length} SHIPMENT(S) LEFT WAITING` : ""));
	}
	return { loads: made.sort((a, b) => a.id.localeCompare(b.id)), unplanned };
}

async function insertLoad(db: D1Database, user: string, day: string, truck: string, driver: string, route: Waiting[], plan: Plan): Promise<Load> {
	const id = "(SELECT printf('LD%05d', value) FROM counters WHERE name = 'load_id')";
	try {
		const res = await db.batch<Load>([
			db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'load_id'"),
			db.prepare(
				`INSERT INTO loads (id, day, truck_id, driver_id, status, region, miles, drive_min, duty_min, created, created_by)
				 VALUES (${id}, ?, ?, ?, 'P', ?, ?, ?, ?, ?, ?) RETURNING *`,
			).bind(day, truck, driver, region(route), plan.miles, plan.drive_min, plan.duty_min, now(), user),
			...route.map((w, i) => db.prepare(
				`INSERT INTO load_stops (load_id, seq, shipment_id, name, city, state, weight, cartons, leg_miles, eta_min)
				 VALUES (${id}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(i + 1, w.shipment_id, w.name, w.city, w.state, w.weight, w.cartons, plan.legs[i], plan.eta[i])),
		]);
		return res[1].results[0];
	} catch (e) {
		// Another planner took the truck, the driver or a shipment first.
		if (String(e).includes("UNIQUE")) throw new HttpError(409, "conflict", "loads were planned by another user - review and plan again");
		throw e;
	}
}

// ---- loads ----

const summary = `SELECT l.*, COUNT(s.seq) AS stops, COALESCE(SUM(s.weight), 0) AS weight, COALESCE(SUM(s.cartons), 0) AS cartons,
	  COUNT(CASE WHEN s.pod_status = 'D' THEN 1 END) AS delivered, COUNT(CASE WHEN s.pod_status = 'X' THEN 1 END) AS missed
	FROM loads l LEFT JOIN load_stops s ON s.load_id = l.id`;

// listLoads returns a day's loads.
export async function listLoads(db: D1Database, day: string): Promise<LoadSummary[]> {
	const { results } = await db.prepare(`${summary} WHERE l.day = ? GROUP BY l.id ORDER BY l.truck_id, l.id`).bind(day).all<LoadSummary>();
	return results;
}

export async function getLoad(db: D1Database, id: string): Promise<{ load: LoadSummary; stops: StopStatus[]; truck: Truck; driver: Driver }> {
	const lid = /^(LD)?\d{1,5}$/i.test(id.trim()) ? "LD" + id.trim().toUpperCase().replace(/^LD/, "").padStart(5, "0") : id.trim().toUpperCase();
	const load = await db.prepare(`${summary} WHERE l.id = ? GROUP BY l.id`).bind(lid).first<LoadSummary>();
	if (!load) throw new HttpError(404, "not_found", `load ${lid} not found`);
	const { results: stops } = await db.prepare(
		`SELECT s.*, h.invoice_id, h.customer_id, h.status AS ship_status, h.delivery, h.delivered, h.signed_by
		 FROM load_stops s JOIN shipments h ON h.id = s.shipment_id WHERE s.load_id = ? ORDER BY s.seq`,
	).bind(lid).all<StopStatus>();
	const [truck, driver] = await Promise.all([getTruck(db, load.truck_id), getDriver(db, load.driver_id)]);
	return { load, stops, truck, driver };
}

export type StopOnLoad = Load & Pick<Stop, "seq" | "pod_status" | "pod_at" | "pod_note"> & { stops: number };

// loadFor returns the load a shipment rides on, if any: the one it is on
// now, or the last that brought it back.
export async function loadFor(db: D1Database, shipmentId: string): Promise<StopOnLoad | undefined> {
	return (await db.prepare(
		`SELECT l.*, s.seq, s.pod_status, s.pod_at, s.pod_note, (SELECT COUNT(*) FROM load_stops WHERE load_id = l.id) AS stops
		 FROM load_stops s JOIN loads l ON l.id = s.load_id WHERE s.shipment_id = ?
		 ORDER BY s.pod_status = 'X', l.created DESC LIMIT 1`,
	).bind(shipmentId).first<StopOnLoad>()) ?? undefined;
}

async function planned(db: D1Database, id: string, doing: string) {
	const got = await getLoad(db, id);
	if (got.load.status !== "P") throw bad("status", `load ${got.load.id} is ${loadStatusNames[got.load.status].toLowerCase()} - it cannot be ${doing}`);
	return got;
}

// checkCrew says why a truck and driver cannot run a load, if they cannot.
async function checkCrew(db: D1Database, load: LoadSummary, truck: Truck, driver: Driver): Promise<void> {
	if (truck.status !== "A") throw bad("truck", `truck ${truck.id} is ${truckStatusNames[truck.status].toLowerCase()}`);
	if (serviceState(truck, load.day) === "DUE") throw bad("truck", `truck ${truck.id} is due for service`);
	if (truck.capacity_lb < load.weight) throw bad("truck", `the load is ${load.weight} lb - truck ${truck.id} carries ${truck.capacity_lb}`);
	if (driver.status !== "A") throw bad("driver", `driver ${driver.id} is ${driverStatusNames[driver.status].toLowerCase()}`);
	if (driver.cdl_expires < load.day) throw bad("driver", `driver ${driver.id}'s license expired ${driver.cdl_expires}`);
	if (!canDrive(driver.cdl_class, truck.cdl_class)) throw bad("driver", `truck ${truck.id} takes a class ${truck.cdl_class} license - driver ${driver.id} has class ${driver.cdl_class}`);
	const used = await dutyMinutes(db, driver.id, load.day, load.id);
	if (used + load.duty_min > WEEK_DUTY_MIN) {
		throw bad("driver", `driver ${driver.id} has ${Math.max(WEEK_DUTY_MIN - used, 0) / 60 | 0} hours left this week - the load takes ${Math.ceil(load.duty_min / 60)}`);
	}
}

// assignLoad puts a planned load on another truck or driver.
export async function assignLoad(db: D1Database, user: string, id: string, truckId: string, driverId: string): Promise<LoadSummary> {
	const { load } = await planned(db, id, "changed");
	const truck = await getTruck(db, truckId || load.truck_id).catch(() => { throw bad("truck", `truck ${truckId.toUpperCase()} not found`); });
	const driver = await getDriver(db, driverId || load.driver_id).catch(() => { throw bad("driver", `driver ${driverId.toUpperCase()} not found`); });
	await checkCrew(db, load, truck, driver);
	for (const [col, v, what] of [["truck_id", truck.id, "truck"], ["driver_id", driver.id, "driver"]] as const) {
		const other = await db.prepare(`SELECT id FROM loads WHERE ${col} = ? AND day = ? AND id <> ?`).bind(v, load.day, load.id).first<{ id: string }>();
		if (other) throw bad(what, `${what} ${v} is on load ${other.id} that day`);
	}
	const res = await db.prepare("UPDATE loads SET truck_id = ?2, driver_id = ?3 WHERE id = ?1 AND status = 'P'").bind(load.id, truck.id, driver.id).run();
	if (res.meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	if (truck.id !== load.truck_id || driver.id !== load.driver_id) {
		await syslog(db, user, `CUS1905I LOAD ${load.id} ON TRUCK ${truck.id} WITH DRIVER ${driver.id}`);
	}
	return (await getLoad(db, load.id)).load;
}

// cancelLoad takes a planned load apart: its shipments wait to be planned again.
export async function cancelLoad(db: D1Database, user: string, id: string): Promise<void> {
	const { load } = await planned(db, id, "cancelled");
	const [, del] = await db.batch([
		db.prepare("DELETE FROM load_stops WHERE load_id = ?1 AND EXISTS (SELECT 1 FROM loads WHERE id = ?1 AND status = 'P')").bind(load.id),
		db.prepare("DELETE FROM loads WHERE id = ? AND status = 'P'").bind(load.id),
	]);
	if (del.meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	await syslog(db, user, `CUS1906I LOAD ${load.id} CANCELLED, ${load.stops} SHIPMENT(S) BACK TO WAITING`);
}

// replan puts a planned load's stops back in order and times them again,
// after a shipment came off it.
async function replan(db: D1Database, load: Load, stops: Stop[]): Promise<void> {
	const pts = stops.map((s) => ({ ...s, ...locate(s.city, s.state) }));
	const route = sequence(pts);
	const plan = schedule(route);
	await db.batch([
		db.prepare("DELETE FROM load_stops WHERE load_id = ?").bind(load.id),
		...route.map((s, i) => db.prepare(
			`INSERT INTO load_stops (load_id, seq, shipment_id, name, city, state, weight, cartons, leg_miles, eta_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(load.id, i + 1, s.shipment_id, s.name, s.city, s.state, s.weight, s.cartons, plan.legs[i], plan.eta[i])),
		db.prepare("UPDATE loads SET miles = ?2, drive_min = ?3, duty_min = ?4, region = ?5 WHERE id = ?1")
			.bind(load.id, plan.miles, plan.drive_min, plan.duty_min, region(route)),
	]);
}

// dispatchLoad sends a planned load on its way: each shipment ships (with
// an 856 for EDI orders) and is out for delivery on the truck.
export async function dispatchLoad(db: D1Database, tables: KVNamespace, user: string, id: string): Promise<{ load: LoadSummary; shipped: string[] }> {
	let { load, stops, truck, driver } = await planned(db, id, "dispatched");
	if (stops.length === 0) throw bad("status", `load ${load.id} has no stops left - cancel it`);
	if (stops.some((s, i) => s.seq !== i + 1)) {
		await replan(db, load, stops);
		({ load, stops, truck, driver } = await getLoad(db, load.id));
	}
	await checkCrew(db, load, truck, driver);
	const packed = stops.filter((s) => s.ship_status === "K");
	const res = await db.prepare(
		"UPDATE loads SET status = 'D', dispatched = ?2, dispatched_by = ?3 WHERE id = ?1 AND status = 'P'",
	).bind(load.id, now(), user).run();
	if (res.meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	const shipped: string[] = [];
	for (const s of stops) {
		if (packed.includes(s)) {
			const { shipment } = await ship(db, user, s.shipment_id, load.id);
			await trackShipment(db, tables, shipment);
		} else {
			// Back out after a failed delivery.
			const shp = await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(s.shipment_id).first<Shipment>();
			if (shp) await trackShipment(db, tables, shp);
		}
		shipped.push(s.shipment_id);
	}
	await syslog(db, user, `CUS1907I LOAD ${load.id} DISPATCHED: TRUCK ${truck.id}, DRIVER ${driver.id}, ${stops.length} STOP(S), ${load.miles} MI`);
	return { load: (await getLoad(db, load.id)).load, shipped };
}

// returnLoad closes a dispatched load when the truck is back: miles is the
// odometer's reading of the run, the planned miles if 0, and the truck's
// odometer goes up by it. The load is costed (loadCost) and the cost
// shared over its shipments by weight.
export async function returnLoad(db: D1Database, tables: KVNamespace, user: string, id: string, actual = 0): Promise<LoadSummary> {
	const { load, stops, truck, driver } = await getLoad(db, id);
	if (load.status !== "D") throw bad("status", `load ${load.id} is ${loadStatusNames[load.status].toLowerCase()} - only a dispatched load comes back`);
	if (!Number.isInteger(actual) || actual < 0 || actual > 5000) throw bad("miles", "the miles must be a whole number from 0 to 5000");
	const open = load.stops - load.delivered - load.missed;
	if (open > 0) throw bad("status", `${open} stop(s) on load ${load.id} have no proof of delivery - mark each delivered or not delivered`);
	const mi = actual || load.miles;
	const at = now();
	const cost = loadCost(truck, driver, mi, load.dispatched, at);
	const carrier = await carrierEquivalent(db, tables, stops);
	const res = await db.prepare(
		`UPDATE loads SET status = 'C', returned = ?2, actual_miles = ?3, cost_miles = ?4, cost_labor = ?5, cost_carrier = ?6
		 WHERE id = ?1 AND status = 'D'`,
	).bind(load.id, at, mi, cost.miles, cost.labor, carrier).run();
	if (res.meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	await db.batch([
		db.prepare("UPDATE trucks SET odometer = odometer + ?2 WHERE id = ?1").bind(load.truck_id, mi),
		...share(cost.miles + cost.labor, stops).map(([shp, dollars]) =>
			db.prepare("UPDATE shipments SET freight_cost = freight_cost + ?2 WHERE id = ?1").bind(shp, dollars)),
	]);
	await syslog(db, user, `CUS1908${load.missed ? "W" : "I"} LOAD ${load.id} BACK: TRUCK ${load.truck_id}, ${mi} MI` +
		(load.missed ? `, ${load.missed} SHIPMENT(S) BACK TO REDELIVER` : ""));
	return (await getLoad(db, load.id)).load;
}

// ---- freight costs ----

// loadCost is what a run cost: its miles at the truck's cost per mile, and
// the driver's time on duty, from leaving to coming back plus the
// pre-trip, at their rate. Whole dollars.
export function loadCost(truck: Truck, driver: Driver, mi: number, left: string, back: string): { miles: number; labor: number } {
	const minutes = Math.max(Math.round((Date.parse(back) - Date.parse(left)) / 60_000), 0) + PRETRIP_MIN;
	return { miles: Math.round(mi * truck.cost_per_mile), labor: Math.round((minutes / 60) * driver.hourly_rate) };
}

// share splits whole dollars over stops by weight; the cents left over go
// to the heaviest.
export function share(total: number, stops: Pick<Stop, "shipment_id" | "weight">[]): [string, number][] {
	const lb = stops.reduce((t, s) => t + s.weight, 0);
	if (stops.length === 0 || total <= 0) return [];
	const parts = stops.map((s) => [s.shipment_id, Math.floor((total * (lb ? s.weight / lb : 1 / stops.length)))] as [string, number]);
	const left = total - parts.reduce((t, [, d]) => t + d, 0);
	const heaviest = stops.reduce((h, s, i) => (s.weight > stops[h].weight ? i : h), 0);
	parts[heaviest][1] += left;
	return parts;
}

// carrierEquivalent is what the carriers would have charged for a load's
// shipments: each by the CARRIER table as if there were no truck.
export async function carrierEquivalent(db: D1Database, tables: KVNamespace, stops: Pick<Stop, "shipment_id" | "state" | "weight" | "cartons">[]): Promise<number> {
	const table = (await carrierRates(tables)).filter((c) => c.code !== "TRK");
	let total = 0;
	for (const s of stops) {
		const inv = await db.prepare("SELECT i.total FROM shipments h JOIN invoices i ON i.id = h.invoice_id WHERE h.id = ?").bind(s.shipment_id).first<{ total: number }>();
		const c = chooseCarrier(table, { state: s.state, weight: s.weight, maxCarton: Math.ceil(s.weight / Math.max(s.cartons, 1)), value: inv?.total ?? 0 })
			?? table[table.length - 1];
		if (c) total += freight(c, s.weight);
	}
	return Math.round(total);
}

export interface CostRow {
	load: Load & { stops: number; weight: number };
	cost: number; // the truck's: miles and labor
	per_mile: number;
	saved: number; // what the carriers would have charged, less the truck's cost
}

export interface FreightCosts {
	month: string; // YYYY-MM
	loads: CostRow[];
	truck: { loads: number; miles: number; weight: number; cost: number; carrier: number };
	carriers: { carrier: string; shipments: number; weight: number; cost: number }[];
}

// freightCosts is a month's freight: each company truck load that came
// back, with its cost against what the carriers would have charged, and
// what each carrier charged for the shipments it took.
export async function freightCosts(db: D1Database, month: string): Promise<FreightCosts> {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad("month", "the month must be YYYY-MM");
	const { results } = await db.prepare(
		`SELECT l.*, COUNT(s.seq) AS stops, COALESCE(SUM(s.weight), 0) AS weight
		 FROM loads l LEFT JOIN load_stops s ON s.load_id = l.id
		 WHERE l.status = 'C' AND substr(l.day, 1, 7) = ? GROUP BY l.id ORDER BY l.day, l.id`,
	).bind(month).all<Load & { stops: number; weight: number }>();
	const loads = results.map((l) => {
		const cost = l.cost_miles + l.cost_labor;
		return { load: l, cost, per_mile: l.actual_miles ? Math.round((cost / l.actual_miles) * 100) / 100 : 0, saved: l.cost_carrier - cost };
	});
	const { results: carriers } = await db.prepare(
		`SELECT carrier, COUNT(*) AS shipments, COALESCE(SUM(weight), 0) AS weight, COALESCE(SUM(freight_cost), 0) AS cost
		 FROM shipments WHERE status = 'S' AND carrier <> 'TRK' AND substr(shipped, 1, 7) = ? GROUP BY carrier ORDER BY carrier`,
	).bind(month).all<{ carrier: string; shipments: number; weight: number; cost: number }>();
	return {
		month, loads, carriers,
		truck: {
			loads: loads.length,
			miles: loads.reduce((t, r) => t + r.load.actual_miles, 0),
			weight: loads.reduce((t, r) => t + r.load.weight, 0),
			cost: loads.reduce((t, r) => t + r.cost, 0),
			carrier: loads.reduce((t, r) => t + r.load.cost_carrier, 0),
		},
	};
}

// ---- proof of delivery ----

async function stopToSign(db: D1Database, loadId: string, shipmentId: string) {
	const got = await getLoad(db, loadId);
	const stop = got.stops.find((s) => s.shipment_id === shipmentId.trim().toUpperCase());
	if (!stop) throw new HttpError(404, "not_found", `${shipmentId.toUpperCase()} is not on load ${got.load.id}`);
	if (got.load.status !== "D") throw bad("status", `load ${got.load.id} is ${loadStatusNames[got.load.status].toLowerCase()} - stops are signed off while it is out`);
	if (stop.pod_status !== "") throw bad("status", `stop ${stop.seq} (${stop.shipment_id}) is already signed off`);
	return { ...got, stop };
}

// activeStop returns the dispatched load and stop a shipment is out on and
// not yet signed off, if any.
export async function activeStop(db: D1Database, shipmentId: string): Promise<StopOnLoad | undefined> {
	const l = await loadFor(db, shipmentId);
	return l && l.status === "D" && l.pod_status === "" ? l : undefined;
}

// deliverStop records a stop delivered: who signed, the cartons they took
// (all of them if 0) and a note such as a shortage or damage. The shipment
// is delivered, which its order's timeline shows.
export async function deliverStop(db: D1Database, user: string, loadId: string, shipmentId: string, signedBy: string, cartons = 0, note = ""): Promise<StopStatus> {
	const { load, stop } = await stopToSign(db, loadId, shipmentId);
	const who = signedBy.trim().toUpperCase();
	if (!who) throw bad("signed", "enter who signed for it");
	if (who.length > 20) throw bad("signed", "signed by is at most 20 characters");
	if (!Number.isInteger(cartons) || cartons < 0 || cartons > stop.cartons) throw bad("cartons", `cartons taken must be from 0 to ${stop.cartons}`);
	const ctn = cartons || stop.cartons;
	const memo = (note.trim() || (ctn < stop.cartons ? `SHORT ${stop.cartons - ctn} CTN` : "")).toUpperCase().slice(0, 30);
	const at = now();
	const where = `${stop.city}, ${stop.state}`;
	const open = "EXISTS (SELECT 1 FROM load_stops WHERE load_id = ?1 AND shipment_id = ?2 AND pod_status = '')";
	const res = await db.batch([
		db.prepare(
			`INSERT INTO tracking_events (shipment_id, at, code, location, detail) SELECT ?2, ?3, 'DELIVERED', ?4, ?5 WHERE ${open}
			 ON CONFLICT (shipment_id, at, code) DO NOTHING`,
		).bind(load.id, stop.shipment_id, at, where.slice(0, 30), `DELIVERED, SIGNED BY ${who}${memo ? " - " + memo : ""}`.slice(0, 60)),
		db.prepare(
			`UPDATE shipments SET delivery = 'D', delivered = ?3, signed_by = ?4, tracked = ?3, eta = substr(?3, 1, 10) WHERE id = ?2 AND ${open}`,
		).bind(load.id, stop.shipment_id, at, who),
		db.prepare(
			`UPDATE load_stops SET pod_status = 'D', pod_at = ?3, pod_signed = ?4, pod_cartons = ?5, pod_note = ?6, pod_by = ?7
			 WHERE load_id = ?1 AND shipment_id = ?2 AND pod_status = ''`,
		).bind(load.id, stop.shipment_id, at, who, ctn, memo, user),
	]);
	if (res[2].meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	await syslog(db, user, `CUS1940I ${stop.shipment_id} DELIVERED, STOP ${stop.seq} OF LOAD ${load.id}, SIGNED BY ${who}${memo ? " - " + memo : ""}`.slice(0, 120));
	return (await getLoad(db, load.id)).stops.find((s) => s.seq === stop.seq)!;
}

// stopNotDelivered records a stop the truck could not deliver, and why
// (receiver closed, refused, no one to sign). The shipment rides back to
// the warehouse and waits for another load; its order's timeline shows
// the exception.
export async function stopNotDelivered(db: D1Database, user: string, loadId: string, shipmentId: string, reason: string): Promise<StopStatus> {
	const { load, stop } = await stopToSign(db, loadId, shipmentId);
	const why = reason.trim().toUpperCase();
	if (!why) throw bad("signed", "enter why it was not delivered");
	if (why.length > 30) throw bad("signed", "the reason is at most 30 characters");
	const at = now();
	const open = "EXISTS (SELECT 1 FROM load_stops WHERE load_id = ?1 AND shipment_id = ?2 AND pod_status = '')";
	const res = await db.batch([
		db.prepare(
			`INSERT INTO tracking_events (shipment_id, at, code, location, detail) SELECT ?2, ?3, 'EXCEPTION', ?4, ?5 WHERE ${open}
			 ON CONFLICT (shipment_id, at, code) DO NOTHING`,
		).bind(load.id, stop.shipment_id, at, `${stop.city}, ${stop.state}`.slice(0, 30), `NOT DELIVERED: ${why} - BACK TO WAREHOUSE`.slice(0, 60)),
		db.prepare(`UPDATE shipments SET delivery = 'X', tracked = ?3, eta = '' WHERE id = ?2 AND ${open}`).bind(load.id, stop.shipment_id, at),
		db.prepare(
			`UPDATE load_stops SET pod_status = 'X', pod_at = ?3, pod_note = ?4, pod_by = ?5 WHERE load_id = ?1 AND shipment_id = ?2 AND pod_status = ''`,
		).bind(load.id, stop.shipment_id, at, why, user),
	]);
	if (res[2].meta.changes === 0) throw new HttpError(409, "conflict", "record was changed by another user");
	await syslog(db, user, `CUS1941W ${stop.shipment_id} NOT DELIVERED, STOP ${stop.seq} OF LOAD ${load.id}: ${why}`.slice(0, 120));
	return (await getLoad(db, load.id)).stops.find((s) => s.seq === stop.seq)!;
}

// ---- the dispatch board ----

export interface BoardRow {
	load: LoadSummary;
	truck: Truck;
	driver: Driver;
	stops: StopStatus[];
	next?: StopStatus; // the first stop not signed off yet
	nextEta: string; // RFC 3339, when the truck should be there: the plan, from the last stop signed off
	backEta: string; // ... and back at the warehouse
	late: boolean; // the plan had it at the next stop already
}

// board is the dispatch board for a day: every load, where its truck is in
// the day and when it is due back.
export async function board(db: D1Database, day: string, at = Date.now()): Promise<BoardRow[]> {
	const rows: BoardRow[] = [];
	for (const l of await listLoads(db, day)) {
		const { load, stops, truck, driver } = await getLoad(db, l.id);
		const next = load.status === "C" ? undefined : stops.find((s) => s.pod_status === "");
		const left = load.dispatched ? Date.parse(load.dispatched) : NaN;
		// From the last stop signed off, the plan's time from there on.
		const last = stops.filter((s) => s.pod_at && (!next || s.seq < next.seq)).pop();
		const from = last ? Date.parse(last.pod_at) + (next ? next.eta_min - last.eta_min - DWELL_MIN : 0) * 60_000 : left + (next?.eta_min ?? 0) * 60_000;
		const nextEta = next && !isNaN(left) ? new Date(from).toISOString() : "";
		const backEta = !isNaN(left) ? new Date(left + (load.duty_min - PRETRIP_MIN) * 60_000).toISOString() : "";
		rows.push({ load, truck, driver, stops, next, nextEta, backEta, late: nextEta !== "" && Date.parse(nextEta) + DWELL_MIN * 60_000 < at });
	}
	return rows;
}

// ---- tracking ----

// fleetTracking is the company truck's TrackingProvider. A shipment on a
// load that has left is on the truck and out for delivery until the
// driver's delivery is signed off; one that is not on a load (shipped by
// hand) is left to the simulator.
export function fleetTracking(db: D1Database, fallback: TrackingProvider): TrackingProvider {
	return {
		name: "FLEET",
		async track(req: TrackRequest, at: number) {
			const load = await loadFor(db, req.shipment);
			if (!load) return fallback.track(req, at);
			// Brought back after a failed delivery: it waits at the
			// warehouse, for another load or on one not gone yet.
			if (load.pod_status === "X" || !load.dispatched) return { delivery: "X", eta: "", scans: [] };
			const gone = new Date(Math.max(Date.parse(load.dispatched), Date.parse(req.shipped))).toISOString();
			const scans: Scan[] = [
				{ at: req.shipped, code: "LABEL", location: DEPOT.name, detail: `ON LOAD ${load.id}, STOP ${load.seq} OF ${load.stops}` },
				{ at: gone, code: "PICKUP", location: DEPOT.name, detail: `LOADED ON TRUCK ${load.truck_id}` },
				{ at: gone, code: "OUTDLVY", location: DEPOT.name, detail: `OUT FOR DELIVERY ON TRUCK ${load.truck_id}, DRIVER ${load.driver_id}` },
			].filter((s) => Date.parse(s.at) <= at) as Scan[];
			return { delivery: scans.some((s) => s.code === "OUTDLVY") ? "O" : "T", eta: load.day, scans };
		},
	};
}

// ---- batch job steps ----

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

// manifestLines is a load's driver manifest.
export function manifestLines(load: LoadSummary, truck: Truck, driver: Driver, stops: StopStatus[]): string[] {
	const lines = [
		"",
		`LOAD MANIFEST ${load.id}   ${load.day}   ${load.region}`,
		`  TRUCK ${truck.id} ${truck.name}  ${truck.plate}`,
		`  DRIVER ${driver.id} ${driver.name}  ${driver.phone}`,
		`  ${load.stops} STOPS  ${load.cartons} CTN  ${load.weight} LB  ${load.miles} MI OUT AND BACK  ${hm(load.duty_min)} ON DUTY` +
			(load.drive_min > MAX_DRIVE_MIN || load.duty_min > MAX_DUTY_MIN ? "  ** OVERNIGHT **" : ""),
		"",
		"  STOP SHIPMENT CUST    NAME                           CITY            ST   CTN     LB  MILES  ETA   SIGNED BY",
		"  ---- -------- ------- ------------------------------ --------------- --  ---- ------ ------ ----- ----------",
	];
	for (const s of stops) {
		lines.push(`  ${String(s.seq).padStart(4)} ${s.shipment_id.padEnd(8)} ${s.customer_id.padEnd(7)} ${s.name.slice(0, 30).padEnd(30)} ` +
			`${s.city.slice(0, 15).padEnd(15)} ${s.state.padEnd(2)}  ${String(s.cartons).padStart(4)} ${String(s.weight).padStart(6)} ` +
			`${String(s.leg_miles).padStart(6)} ${("+" + hm(s.eta_min)).padStart(5)} __________`);
	}
	return lines;
}

// planStep is CUSLOAD's first step: plan today's loads.
export async function planStep(db: D1Database, job: { name: string }): Promise<StepResult> {
	const day = freightDay();
	const { loads, unplanned } = await planLoads(db, job.name, day);
	const lines = ["", `TRUCK LOADS PLANNED FOR ${day}: ${loads.length}`];
	for (const l of loads) lines.push(`  ${l.id}  TRUCK ${l.truck_id}  DRIVER ${l.driver_id}  ${l.region.padEnd(20)} ${String(l.miles).padStart(5)} MI`);
	if (unplanned.length > 0) {
		lines.push("", `SHIPMENTS LEFT WAITING: ${unplanned.length}`);
		for (const u of unplanned) lines.push(`  ${u.shipment_id}  ${u.reason}`);
	}
	return { rc: unplanned.length > 0 ? 4 : 0, lines };
}

// manifestStep is CUSLOAD's second step: a manifest for each of today's
// loads not dispatched yet, for the drivers.
export async function manifestStep(db: D1Database): Promise<StepResult> {
	const day = freightDay();
	const lines: string[] = [];
	let n = 0;
	for (const l of await listLoads(db, day)) {
		if (l.status !== "P") continue;
		const { load, stops, truck, driver } = await getLoad(db, l.id);
		lines.push(...manifestLines(load, truck, driver, stops));
		n++;
	}
	if (n === 0) lines.push("", `NO LOADS WAITING TO BE DISPATCHED ON ${day}`);
	lines.push("", `${n} LOAD MANIFEST(S) PRINTED`);
	return { rc: 0, lines };
}
