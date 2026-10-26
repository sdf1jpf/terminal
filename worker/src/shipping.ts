// Shipping, shared by the REST endpoints (index.ts), the screens
// (screens/shipping.ts) and the batch jobs (jobs.ts).
//
// Releasing an open invoice to the warehouse opens a shipment in PICKING
// (P) and freezes the invoice's lines: its pick ticket lists them by bin.
// Packing it (K) records the cartons and weight, and shipping it (S) the
// carrier and tracking number. A customer that ordered by EDI is sent an
// 856 ship notice. Only a shipped invoice can be billed (invoices.ts).
// Cancelling a shipment that has not shipped puts the invoice back to work.

import { fromEDIOrder, party, send, ymd, type Interchange } from "./edi";
import { HttpError } from "./http";
import { addressOf, cityLine, getInvoice, type Invoice, type InvoiceLine } from "./invoices";
import type { StepResult } from "./jobs";

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
}

export const shipStatusNames: Record<string, string> = { P: "PICKING", K: "PACKED", S: "SHIPPED" };

export const carriers: Record<string, string> = { UPS: "UPS GROUND", FDX: "FEDEX FREIGHT", TRK: "COMPANY TRUCK" };

const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
const now = () => new Date().toISOString();

// binFor is a product's bin location in the warehouse, such as C-14-2. It
// is worked out from the SKU, so every product has one.
export function binFor(sku: string): string {
	let h = 7;
	for (const c of sku) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${"ABCDEF"[h % 6]}-${String(1 + ((h >>> 3) % 24)).padStart(2, "0")}-${1 + ((h >>> 8) % 4)}`;
}

// release opens a shipment for an open invoice with at least one line.
export async function release(db: D1Database, user: string, invoiceId: string): Promise<Shipment> {
	const [, inserted] = await db.batch<Shipment>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'shipment_id'"),
		db.prepare(
			`INSERT INTO shipments (id, invoice_id, customer_id, status, created, created_by)
			 SELECT printf('SHP%05d', c.value), i.id, i.customer_id, 'P', ?2, ?3
			 FROM counters c, invoices i
			 WHERE c.name = 'shipment_id' AND i.id = ?1 AND i.status = 'O'
			   AND EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = ?1)
			 ON CONFLICT (invoice_id) DO NOTHING
			 RETURNING *`,
		).bind(invoiceId, now(), user),
	]);
	if (inserted.results[0]) return inserted.results[0];
	const { invoice, lines } = await getInvoice(db, invoiceId);
	const shp = await shipmentFor(db, invoiceId);
	if (shp) throw bad("sku", `invoice ${invoiceId} is already released on ${shp.id}`);
	if (invoice.status !== "O") throw bad("sku", `invoice ${invoiceId} is already billed`);
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

// pack records a picked shipment's cartons and weight.
export async function pack(db: D1Database, id: string, cartons: number, weight: number): Promise<Shipment> {
	if (!Number.isInteger(cartons) || cartons < 1 || cartons > 999) throw bad("cartons", "cartons must be a whole number from 1 to 999");
	if (!Number.isInteger(weight) || weight < 1 || weight > 99_999) throw bad("weight", "weight must be whole pounds from 1 to 99999");
	const row = await db.prepare(
		"UPDATE shipments SET status = 'K', cartons = ?2, weight = ?3, packed = ?4 WHERE id = ?1 AND status = 'P' RETURNING *",
	).bind(id, cartons, weight, now()).first<Shipment>();
	return row ?? why(db, id, "P", "packed");
}

// tracking makes up a carrier's tracking number for a shipment.
function trackingNumber(carrier: string, id: string): string {
	const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
	if (carrier === "UPS") return `1Z${digits(3)}E${id.slice(3)}${digits(5)}`;
	if (carrier === "FDX") return digits(12);
	return `PRO${id.slice(3)}${digits(4)}`;
}

// ship sends a packed shipment with a carrier and, if its invoice came
// from an 850, sends the customer an 856.
export async function ship(db: D1Database, user: string, id: string, carrier: string): Promise<{ shipment: Shipment; edi?: Interchange }> {
	carrier = carrier.trim().toUpperCase();
	if (!carriers[carrier]) throw bad("carrier", `carrier must be one of ${Object.keys(carriers).join(", ")}`);
	const row = await db.prepare(
		`UPDATE shipments SET status = 'S', carrier = ?2, tracking = ?3, shipped = ?4, shipped_by = ?5
		 WHERE id = ?1 AND status = 'K' RETURNING *`,
	).bind(id, carrier, trackingNumber(carrier, id), now(), user).first<Shipment>();
	const shipment = row ?? (await why(db, id, "K", "shipped"));
	const edi = await sendShipNotice(db, shipment);
	return edi ? { shipment, edi } : { shipment };
}

// cancelShipment deletes a shipment that has not shipped, so its invoice
// can be changed again.
export async function cancelShipment(db: D1Database, id: string): Promise<void> {
	const res = await db.prepare("DELETE FROM shipments WHERE id = ? AND status IN ('P', 'K')").bind(id).run();
	if (res.meta.changes === 1) return;
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
