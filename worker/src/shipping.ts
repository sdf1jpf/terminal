// Shipping, shared by the REST endpoints (index.ts), the screens
// (screens/shipping.ts) and the batch jobs (jobs.ts).
//
// Releasing an open invoice to the warehouse opens a shipment in PICKING
// (P) and freezes the invoice's lines: its pick ticket lists them by bin.
// Packing it (K) records the cartons and weight, and the system chooses the
// carrier from the ship-to, weight and value by the CARRIER table (routeFor). Shipping it (S)
// records the tracking number, and from then on the carrier is asked where
// it is (tracking.ts). A customer that ordered by EDI is sent an
// 856 ship notice. Only a shipped invoice can be billed (invoices.ts).
// Cancelling a shipment that has not shipped puts the invoice back to work.

import { fromEDIOrder, party, send, ymd, type Interchange } from "./edi";
import { HttpError } from "./http";
import { addressOf, cityLine, getInvoice, type Invoice, type InvoiceLine } from "./invoices";
import type { StepResult } from "./jobs";
import { carrierRates, chooseCarrier, type Carrier, type Order } from "./systables";

export interface Shipment {
	id: string;
	invoice_id: string;
	customer_id: string;
	status: "P" | "K" | "S";
	cartons: number;
	weight: number;
	carrier: string;
	tracking: string;
	created: string;
	created_by: string;
	packed: string;
	shipped: string;
	shipped_by: string;
	route: string; // why the carrier was chosen
	delivery: "" | "T" | "O" | "D" | "X"; // once shipped: in transit, out for delivery, delivered, exception (tracking.ts)
	eta: string; // promised delivery date, YYYY-MM-DD
	delivered: string;
	signed_by: string;
	tracked: string; // when the carrier was last asked
}

export const shipStatusNames: Record<string, string> = { P: "PICKING", K: "PACKED", S: "SHIPPED" };

export const carriers: Record<string, string> = { UPS: "UPS GROUND", FDX: "FEDEX FREIGHT", TRK: "COMPANY TRUCK" };

export interface Route {
	carrier: string;
	reason: string;
}

// routeFor chooses a shipment's carrier from the CARRIER system table
// (systables.ts): the first carrier, by priority, whose service area and
// limits take it. The reason says why each carrier ahead of it was passed
// over, and that the ship-to is in the chosen carrier's area if it has one.
export function routeFor(table: Carrier[], shipTo: { state: string }, cartons: number, weight: number, value: number): Route {
	const order = { state: shipTo.state.toUpperCase(), weight, maxCarton: Math.ceil(weight / cartons), value };
	const c = chooseCarrier(table, order);
	if (!c) throw bad("weight", "no carrier in the CARRIER table takes this shipment - check the table");
	const why = table.slice(0, table.indexOf(c)).map((x) => passedOver(x, order));
	why.push(c.service_states.length > 0 ? `${order.state} IS IN THE ${c.code} AREA` : why.length === 0 ? `WITHIN ${c.code} LIMITS` : "");
	return { carrier: c.code, reason: why.filter(Boolean).join("; ") };
}

// passedOver says why a carrier did not take an order.
function passedOver(c: Carrier, o: Order): string {
	if (c.service_states.length > 0 && !c.service_states.includes(o.state)) return `${o.state} OUTSIDE ${c.code} AREA`;
	if (o.weight < c.min_weight_lb) return `${o.weight} LB UNDER ${c.code} ${c.min_weight_lb} LB`;
	if (c.max_weight_lb > 0 && o.weight > c.max_weight_lb) return `${o.weight} LB OVER ${c.code} ${c.max_weight_lb} LB`;
	if (c.max_carton_lb > 0 && o.maxCarton > c.max_carton_lb) return `${o.maxCarton} LB CARTON OVER ${c.code} ${c.max_carton_lb} LB`;
	if (o.value < c.min_value) return `$${o.value} UNDER ${c.code} $${c.min_value}`;
	return `$${o.value} OVER ${c.code} $${c.max_value}`;
}

const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
const now = () => new Date().toISOString();

// binFor is a product's bin location in the warehouse, such as C-14-2. It
// is worked out from the SKU, so every product has one.
export function binFor(sku: string): string {
	let h = 7;
	for (const c of sku) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${"ABCDEF"[h % 6]}-${String(1 + ((h >>> 3) % 24)).padStart(2, "0")}-${1 + ((h >>> 8) % 4)}`;
}

// release opens a shipment for an open invoice with at least one line and
// no EDI lines held for correction (ediexceptions.ts).
export async function release(db: D1Database, user: string, invoiceId: string): Promise<Shipment> {
	const [, inserted] = await db.batch<Shipment>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'shipment_id'"),
		db.prepare(
			`INSERT INTO shipments (id, invoice_id, customer_id, status, created, created_by)
			 SELECT printf('SHP%05d', c.value), i.id, i.customer_id, 'P', ?2, ?3
			 FROM counters c, invoices i
			 WHERE c.name = 'shipment_id' AND i.id = ?1 AND i.status = 'O'
			   AND EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = ?1)
			   AND NOT EXISTS (SELECT 1 FROM edi_exceptions WHERE invoice_id = ?1 AND status = 'O')
			 ON CONFLICT (invoice_id) DO NOTHING
			 RETURNING *`,
		).bind(invoiceId, now(), user),
	]);
	if (inserted.results[0]) return inserted.results[0];
	const { invoice, lines } = await getInvoice(db, invoiceId);
	const shp = await shipmentFor(db, invoiceId);
	if (shp) throw bad("sku", `invoice ${invoiceId} is already released on ${shp.id}`);
	if (invoice.status !== "O") throw bad("sku", `invoice ${invoiceId} is already billed`);
	const held = await db.prepare("SELECT COUNT(*) AS n FROM edi_exceptions WHERE invoice_id = ? AND status = 'O'").bind(invoiceId).first<{ n: number }>();
	if (held!.n > 0) throw bad("sku", `invoice ${invoiceId} has ${held!.n} EDI line(s) held for correction - see option 2.5`);
	if (lines.length === 0) throw bad("sku", "add at least one line before releasing it to the warehouse");
	throw new HttpError(409, "conflict", "record was changed by another user");
}

export async function shipmentFor(db: D1Database, invoiceId: string): Promise<Shipment | undefined> {
	return (await db.prepare("SELECT * FROM shipments WHERE invoice_id = ?").bind(invoiceId).first<Shipment>()) ?? undefined;
}

// listShipments returns shipments newest first, optionally only those in
// one status.
export async function listShipments(db: D1Database, status = ""): Promise<Shipment[]> {
	const { results } = await db.prepare(
		"SELECT * FROM shipments WHERE ?1 = '' OR status = ?1 ORDER BY id DESC LIMIT 500",
	).bind(status.toUpperCase()).all<Shipment>();
	return results;
}

export async function getShipment(db: D1Database, id: string): Promise<{ shipment: Shipment; invoice: Invoice; lines: InvoiceLine[] }> {
	const shipment = await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(id.toUpperCase()).first<Shipment>();
	if (!shipment) throw new HttpError(404, "not_found", "shipment not found");
	const { invoice, lines } = await getInvoice(db, shipment.invoice_id);
	return { shipment, invoice, lines };
}

async function why(db: D1Database, id: string, want: string, doing: string): Promise<never> {
	const { shipment } = await getShipment(db, id);
	if (shipment.status === want) throw new HttpError(409, "conflict", "record was changed by another user");
	throw bad("status", `shipment ${id} is ${shipStatusNames[shipment.status].toLowerCase()} - it cannot be ${doing}`);
}

// pack records a picked shipment's cartons and weight, and routes it by
// the CARRIER table in tables.
export async function pack(db: D1Database, tables: KVNamespace, id: string, cartons: number, weight: number): Promise<Shipment> {
	if (!Number.isInteger(cartons) || cartons < 1 || cartons > 999) throw bad("cartons", "cartons must be a whole number from 1 to 999");
	if (!Number.isInteger(weight) || weight < 1 || weight > 99_999) throw bad("weight", "weight must be whole pounds from 1 to 99999");
	const { shipment, invoice } = await getShipment(db, id);
	const r = routeFor(await carrierRates(tables), addressOf(invoice, "ship"), cartons, weight, invoice.total);
	const row = await db.prepare(
		`UPDATE shipments SET status = 'K', cartons = ?2, weight = ?3, packed = ?4, carrier = ?5, route = ?6
		 WHERE id = ?1 AND status = 'P' RETURNING *`,
	).bind(shipment.id, cartons, weight, now(), r.carrier, r.reason).first<Shipment>();
	return row ?? why(db, id, "P", "packed");
}

// tracking makes up a carrier's tracking number for a shipment.
function trackingNumber(carrier: string, id: string): string {
	const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
	if (carrier === "UPS") return `1Z${digits(3)}E${id.slice(3)}${digits(5)}`;
	if (carrier === "FDX") return digits(12);
	return `PRO${id.slice(3)}${digits(4)}`;
}

// ship sends a packed shipment with the carrier chosen when it was packed
// and, if its invoice came from an 850, sends the customer an 856. A
// shipment on a company truck load ships when the load is dispatched
// (fleet.ts), which passes the load as onLoad.
export async function ship(db: D1Database, user: string, id: string, onLoad = ""): Promise<{ shipment: Shipment; edi?: Interchange }> {
	const { shipment: packed } = await getShipment(db, id);
	const load = await db.prepare(
		"SELECT l.id FROM load_stops s JOIN loads l ON l.id = s.load_id WHERE s.shipment_id = ? AND l.status = 'P'",
	).bind(packed.id).first<{ id: string }>();
	if (load && load.id !== onLoad) throw bad("status", `shipment ${packed.id} is on truck load ${load.id} - it ships when the load is dispatched (option 7.3)`);
	const row = await db.prepare(
		`UPDATE shipments SET status = 'S', tracking = ?3, shipped = ?4, shipped_by = ?5, delivery = 'T'
		 WHERE id = ?1 AND status = 'K' AND carrier = ?2 RETURNING *`,
	).bind(packed.id, packed.carrier, trackingNumber(packed.carrier, packed.id), now(), user).first<Shipment>();
	const shipment = row ?? (await why(db, id, "K", "shipped"));
	const edi = await sendShipNotice(db, shipment);
	return edi ? { shipment, edi } : { shipment };
}

// cancelShipment deletes a shipment that has not shipped, so its invoice
// can be changed again.
export async function cancelShipment(db: D1Database, id: string): Promise<void> {
	const res = await db.prepare("DELETE FROM shipments WHERE id = ? AND status IN ('P', 'K')").bind(id).run();
	if (res.meta.changes > 0) return; // with the order signal its trigger adds (lifecycle.ts)
	await why(db, id, "", "cancelled");
}

async function sendShipNotice(db: D1Database, shp: Shipment): Promise<Interchange | undefined> {
	const { invoice, lines } = await getInvoice(db, shp.invoice_id);
	if (!(await fromEDIOrder(db, invoice))) return undefined;
	const at = new Date(shp.shipped);
	return send(db, shp.customer_id, "856", [
		["BSN", "00", shp.id, ymd(at), ymd(at).slice(4)],
		["HL", "1", "", "S"],
		["TD1", "CTN", shp.cartons, "", "", "", "G", shp.weight, "LB"],
		["TD5", "", "2", shp.carrier, "", carriers[shp.carrier]],
		["REF", "CN", shp.tracking],
		["DTM", "011", ymd(at)],
		...party("ST", addressOf(invoice, "ship")),
		["HL", "2", "1", "O"],
		["PRF", invoice.po_number, "", "", "", "", invoice.id],
		...lines.flatMap((l, i) => [["HL", 3 + i, "2", "I"], ["LIN", l.line, "VP", l.sku], ["SN1", "", l.quantity, "EA"]]),
		["CTT", lines.length + 2],
	], `${shp.id} ${invoice.id}`);
}

// ---- batch job steps ----

// pickTickets is CUSPICK's step: a pick ticket for every shipment still in
// picking, its lines in bin order so the picker walks the aisles once.
export async function pickTickets(db: D1Database): Promise<StepResult> {
	const { results } = await db.prepare(
		`SELECT s.id, s.invoice_id, s.customer_id, i.po_number, i.ship_name, i.ship_address, i.ship_city, i.ship_state, i.ship_zip
		 FROM shipments s JOIN invoices i ON i.id = s.invoice_id
		 WHERE s.status = 'P' ORDER BY s.id`,
	).all<Pick<Shipment, "id" | "invoice_id" | "customer_id"> & Pick<Invoice, "po_number" | "ship_name" | "ship_address" | "ship_city" | "ship_state" | "ship_zip">>();
	const lines: string[] = [];
	for (const s of results) {
		const { lines: items } = await getInvoice(db, s.invoice_id);
		const to = addressOf(s, "ship");
		lines.push(
			"",
			`PICK TICKET ${s.id}   INVOICE ${s.invoice_id}   PO ${s.po_number || "(NONE)"}`,
			`  SHIP TO ${s.customer_id} ${to.name}`,
			...(to.address ? [`          ${to.address}`] : []),
			`          ${cityLine(to)}`,
			"",
			"  BIN     SKU        DESCRIPTION                       QTY  PICKED",
			"  ------- ---------- ------------------------------ ------  ------",
		);
		const byBin = items.map((l) => ({ ...l, bin: binFor(l.sku) })).sort((a, b) => a.bin.localeCompare(b.bin));
		for (const l of byBin) {
			lines.push(`  ${l.bin.padEnd(7)} ${l.sku.padEnd(10)} ${l.description.slice(0, 30).padEnd(30)} ${String(l.quantity).padStart(6)}  ______`);
		}
	}
	if (results.length === 0) lines.push("", "NO SHIPMENTS WAITING TO BE PICKED");
	lines.push("", `${results.length} PICK TICKETS PRINTED`);
	return { rc: 0, lines };
}
