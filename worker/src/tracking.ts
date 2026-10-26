// Shipment tracking. Once a shipment has gone, its carrier is asked where
// it is: every scan the carrier reports is kept in tracking_events, and the
// shipment carries the latest delivery status, the promised date and, once
// delivered, when and who signed for it (migration 0030).
//
// Each carrier is reached through a TrackingProvider. Until a carrier's API
// is set up (UPS and FedEx need developer credentials, see README), the
// simulated provider stands in: it plays out a believable trip for each
// tracking number from the ship date and the CARRIER table's transit days,
// the same every time it is asked. Company truck deliveries can also be
// signed off by hand from the tracking screen (confirmDelivery).
//
// The cron trigger asks about every shipment still on its way every
// POLL_EVERY (pollTracking); the tracking screen and REST ask on demand.
// Out for delivery, delivered and exceptions wake the order's lifecycle
// through a D1 trigger, which puts them on its timeline (lifecycle.ts).

import { HttpError } from "./http";
import { getInvoice, addressOf, type Address } from "./invoices";
import type { Shipment } from "./shipping";
import { syslog } from "./syslog";
import { fleetTracking } from "./fleet";
import { carrierRates } from "./systables";

export type Delivery = "" | "T" | "O" | "D" | "X";

export const deliveryNames: Record<string, string> = {
	"": "NOT TRACKED YET", T: "IN TRANSIT", O: "OUT FOR DELIVERY", D: "DELIVERED", X: "EXCEPTION",
};

// deliveryShort names fit the shipment list's 8-column status.
export const deliveryShort: Record<string, string> = { "": "SHIPPED", T: "INTRANS", O: "OUTDLVY", D: "DELIVRD", X: "EXCEPTN" };

export type ScanCode = "LABEL" | "PICKUP" | "DEPART" | "ARRIVE" | "OUTDLVY" | "DELIVERED" | "EXCEPTION";

export interface Scan {
	at: string; // RFC 3339, UTC
	code: ScanCode;
	location: string; // CITY, ST
	detail: string;
}

export interface TrackingEvent extends Scan {
	seq: number;
	shipment_id: string;
}

// What a provider is asked about: one shipment on its way.
export interface TrackRequest {
	shipment: string; // SHP00012
	carrier: string; // UPS, FDX, TRK
	tracking: string;
	shipped: string; // RFC 3339, UTC
	shipTo: Address;
	transitDays: number; // from the CARRIER table
}

// What a provider answers: the scans so far, oldest first, and where that
// leaves the shipment.
export interface TrackResult {
	delivery: Exclude<Delivery, "">;
	eta: string; // YYYY-MM-DD, the date the carrier now promises
	delivered?: string; // RFC 3339, UTC
	signedBy?: string;
	scans: Scan[];
}

export interface TrackingProvider {
	readonly name: string;
	track(req: TrackRequest, now: number): Promise<TrackResult>;
}

// ---- the simulated carrier ----

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The warehouse ships from Ohio (see the CARRIER table's truck area).
const ORIGIN = "COLUMBUS, OH";
const hubs: Record<string, string> = { UPS: "LOUISVILLE, KY", FDX: "MEMPHIS, TN" };
const names: Record<string, string> = { UPS: "UPS", FDX: "FEDEX", TRK: "COMPANY TRUCK" };
const signers = ["RECEIVING", "SMITH", "JOHNSON", "GARCIA", "FRONT DESK", "DOCK 2", "MILLER", "NGUYEN"];

function hash(s: string): number {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
	return h;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// The UTC midnight a number of days after a moment.
const dayStart = (ms: number, days: number) => Math.floor(ms / DAY) * DAY + days * DAY;

// simulatedTrip is every scan a shipment will get, oldest first, with when
// it was promised and delivered. One shipment in ten is held up a day on its
// last leg (weather for the parcel carriers, a closed dock for the truck).
export function simulatedTrip(req: TrackRequest): { scans: Scan[]; promised: string; eta: string; delivered: string; signedBy: string } {
	const h = hash(req.tracking);
	const shipped = Date.parse(req.shipped);
	const days = Math.max(1, req.transitDays);
	const dest = [req.shipTo.city, req.shipTo.state].filter(Boolean).join(", ") || "DESTINATION";
	const who = names[req.carrier] ?? req.carrier;
	const minutes = (n: number) => (h >>> n) % 60;
	const scans: Scan[] = [];
	const add = (at: number, code: ScanCode, location: string, detail: string) =>
		scans.push({ at: new Date(at).toISOString(), code, location, detail });

	add(shipped, "LABEL", ORIGIN, "SHIPPING LABEL CREATED");
	add(shipped + HOUR + minutes(3) * 60_000, "PICKUP", ORIGIN, req.carrier === "TRK" ? "LOADED ON COMPANY TRUCK" : `PICKED UP BY ${who}`);
	const hub = hubs[req.carrier];
	if (hub && days > 1) {
		add(dayStart(shipped, 0) + 22 * HOUR + minutes(5) * 60_000, "DEPART", ORIGIN, "DEPARTED FACILITY");
		add(dayStart(shipped, 1) + 3 * HOUR + minutes(7) * 60_000, "ARRIVE", hub, "ARRIVED AT HUB");
		add(dayStart(shipped, 1) + 9 * HOUR + minutes(9) * 60_000, "DEPART", hub, "DEPARTED HUB");
	}
	if (days > 1) add(dayStart(shipped, days - 1) + 20 * HOUR + minutes(11) * 60_000, "ARRIVE", dest, "ARRIVED AT DESTINATION FACILITY");

	let last = days;
	const promised = ymd(dayStart(shipped, days));
	if (h % 10 === 3) {
		add(dayStart(shipped, last) + 12 * HOUR + minutes(13) * 60_000, "EXCEPTION", dest, req.carrier === "TRK"
			? "RECEIVER CLOSED - REDELIVER NEXT DAY"
			: "WEATHER DELAY - DELIVERY RESCHEDULED");
		last++;
	}
	add(dayStart(shipped, last) + 12 * HOUR + minutes(15) * 60_000, "OUTDLVY", dest, "OUT FOR DELIVERY");
	const delivered = dayStart(shipped, last) + 17 * HOUR + minutes(17) * 60_000;
	const signedBy = signers[(h >>> 20) % signers.length];
	add(delivered, "DELIVERED", dest, `DELIVERED, SIGNED BY ${signedBy}`);
	return { scans, promised, eta: ymd(dayStart(shipped, last)), delivered: new Date(delivered).toISOString(), signedBy };
}

export const simulated: TrackingProvider = {
	name: "SIMULATED",
	async track(req, now) {
		const trip = simulatedTrip(req);
		const scans = trip.scans.filter((s) => Date.parse(s.at) <= now);
		const last = scans[scans.length - 1]?.code;
		const delayed = scans.some((s) => s.code === "EXCEPTION");
		if (last === "DELIVERED") return { delivery: "D", eta: trip.eta, delivered: trip.delivered, signedBy: trip.signedBy, scans };
		return {
			delivery: last === "OUTDLVY" ? "O" : last === "EXCEPTION" ? "X" : "T",
			eta: delayed ? trip.eta : trip.promised,
			scans,
		};
	},
};

// providers holds the carriers whose real tracking API is set up, by
// carrier code. A carrier not in it is tracked by the simulator, except
// that the company truck's loads are tracked by the fleet (fleet.ts).
const providers: Record<string, TrackingProvider> = {};

export function registerProvider(carrier: string, p: TrackingProvider): void {
	providers[carrier] = p;
}

export function providerFor(carrier: string, db?: D1Database): TrackingProvider {
	const p = providers[carrier] ?? simulated;
	return carrier === "TRK" && db ? fleetTracking(db, p) : p;
}

// ---- tracking shipments ----

const now = () => Date.now();

// POLL_EVERY is how often a shipment on its way is asked about.
export const POLL_EVERY = 30 * 60_000;

// trackShipment asks a shipped shipment's carrier where it is, records the
// new scans and the shipment's delivery status, and returns the shipment as
// it now stands. A delivered shipment is left alone.
export async function trackShipment(db: D1Database, tables: KVNamespace, shp: Shipment, at = now()): Promise<Shipment> {
	if (shp.status !== "S" || shp.delivery === "D") return shp;
	const { invoice } = await getInvoice(db, shp.invoice_id);
	const carrier = (await carrierRates(tables)).find((c) => c.code === shp.carrier);
	const provider = providerFor(shp.carrier, db);
	const r = await provider.track({
		shipment: shp.id, carrier: shp.carrier, tracking: shp.tracking, shipped: shp.shipped,
		shipTo: addressOf(invoice, "ship"), transitDays: carrier?.transit_days || 3,
	}, at);
	const stmts = r.scans.map((s) => db.prepare(
		`INSERT INTO tracking_events (shipment_id, at, code, location, detail) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (shipment_id, at, code) DO NOTHING`,
	).bind(shp.id, s.at, s.code, s.location.slice(0, 30), s.detail.slice(0, 60)));
	stmts.push(db.prepare(
		`UPDATE shipments SET delivery = ?2, eta = ?3, delivered = ?4, signed_by = ?5, tracked = ?6
		 WHERE id = ?1 AND status = 'S' AND delivery <> 'D' RETURNING *`,
	).bind(shp.id, r.delivery, r.eta, r.delivered ?? "", (r.signedBy ?? "").slice(0, 20), new Date(at).toISOString()));
	const res = await db.batch<Shipment>(stmts);
	const row = res[res.length - 1].results[0];
	if (!row) return (await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(shp.id).first<Shipment>())!;
	if (row.delivery !== shp.delivery && row.delivery === "X") {
		const why = r.scans.filter((s) => s.code === "EXCEPTION").pop()?.detail ?? "";
		await syslog(db, "CUSTRACK", `CUS1701W ${shp.id} ${shp.invoice_id} ${shp.carrier} EXCEPTION: ${why}`.slice(0, 120));
	}
	return row;
}

// pollTracking asks about the shipments still on their way that have not
// been asked about for POLL_EVERY, longest waiting first, at most limit of
// them. It returns how many it asked about.
export async function pollTracking(db: D1Database, tables: KVNamespace, at = now(), limit = 50): Promise<number> {
	const { results } = await db.prepare(
		`SELECT * FROM shipments WHERE status = 'S' AND delivery <> 'D' AND tracked < ?
		 ORDER BY tracked, id LIMIT ?`,
	).bind(new Date(at - POLL_EVERY).toISOString(), limit).all<Shipment>();
	let n = 0;
	for (const shp of results) {
		try {
			await trackShipment(db, tables, shp, at);
			n++;
		} catch (e) {
			console.error(`tracking ${shp.id}:`, e);
		}
	}
	return n;
}

// findShipment finds a shipment by its number (SHP00012 or 12), its
// invoice (INV00042) or its tracking number.
export async function findShipment(db: D1Database, typed: string): Promise<Shipment | undefined> {
	const v = typed.trim().toUpperCase();
	if (!v) return undefined;
	const id = /^(SHP)?\d{1,5}$/.test(v) ? "SHP" + v.replace(/^SHP/, "").padStart(5, "0") : v;
	const inv = /^INV\d{1,5}$/.test(v) ? "INV" + v.slice(3).padStart(5, "0") : v;
	return (await db.prepare("SELECT * FROM shipments WHERE id = ? OR invoice_id = ? OR (tracking <> '' AND tracking = ?) LIMIT 1")
		.bind(id, inv, v).first<Shipment>()) ?? undefined;
}

// trackingEvents returns a shipment's scans, newest first.
export async function trackingEvents(db: D1Database, id: string): Promise<TrackingEvent[]> {
	const { results } = await db.prepare("SELECT * FROM tracking_events WHERE shipment_id = ? ORDER BY at DESC, seq DESC")
		.bind(id).all<TrackingEvent>();
	return results;
}

// getTracking returns a shipment and its scans, asking the carrier first
// if refresh is set or it has never been asked.
export async function getTracking(db: D1Database, tables: KVNamespace, id: string, refresh = false): Promise<{ shipment: Shipment; events: TrackingEvent[] }> {
	let shipment = await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(id.toUpperCase()).first<Shipment>();
	if (!shipment) throw new HttpError(404, "not_found", "shipment not found");
	if (shipment.status === "S" && (refresh || !shipment.tracked)) shipment = await trackShipment(db, tables, shipment);
	return { shipment, events: await trackingEvents(db, shipment.id) };
}

// confirmDelivery records a proof of delivery by hand, for the company
// truck, whose drivers have no scanner: who signed, and now.
export async function confirmDelivery(db: D1Database, user: string, id: string, signedBy: string): Promise<Shipment> {
	const who = signedBy.trim().toUpperCase();
	if (!who) throw new HttpError(422, "invalid", "enter who signed for it", "signed");
	if (who.length > 20) throw new HttpError(422, "invalid", "signed by is at most 20 characters", "signed");
	const shp = await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(id.toUpperCase()).first<Shipment>();
	if (!shp) throw new HttpError(404, "not_found", "shipment not found");
	if (shp.status !== "S") throw new HttpError(422, "invalid", `shipment ${shp.id} has not shipped`, "status");
	if (shp.delivery === "D") throw new HttpError(422, "invalid", `shipment ${shp.id} is already delivered`, "status");
	if (shp.carrier !== "TRK") throw new HttpError(422, "invalid", `${shp.carrier} reports its own deliveries - only truck deliveries are signed off by hand`, "status");
	const at = new Date().toISOString();
	const [, updated] = await db.batch<Shipment>([
		db.prepare(
			`INSERT INTO tracking_events (shipment_id, at, code, location, detail) VALUES (?, ?, 'DELIVERED', ?, ?)
			 ON CONFLICT (shipment_id, at, code) DO NOTHING`,
		).bind(shp.id, at, "", `DELIVERED, SIGNED BY ${who} - ENTERED BY ${user}`.slice(0, 60)),
		db.prepare(
			`UPDATE shipments SET delivery = 'D', delivered = ?2, signed_by = ?3, tracked = ?2, eta = substr(?2, 1, 10)
			 WHERE id = ?1 AND status = 'S' AND delivery <> 'D' RETURNING *`,
		).bind(shp.id, at, who),
	]);
	const row = updated.results[0];
	if (!row) throw new HttpError(409, "conflict", "record was changed by another user");
	await syslog(db, user, `CUS1702I ${shp.id} DELIVERED BY TRUCK, SIGNED BY ${who}`);
	return row;
}
