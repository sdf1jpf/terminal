// Purchasing: vendors, purchase orders and receiving, shared by the REST
// endpoints (index.ts), the screens (screens/purchasing.ts) and the batch
// jobs (jobs.ts).
//
// A purchase order is OPEN (O) while it is being built: lines can be added
// and removed, and each is costed at the product's unit cost. Only products
// the PO's vendor supplies can go on it. Sending it (S) freezes it and
// sends the vendor an 850. The vendor's 855 confirms it (A) with a ship
// date, and its 856 says it is in transit (T). Goods can be received
// against any sent PO; each receipt puts the quantity in stock, and the PO
// is RECEIVED (R) once every line is in.
//
// The CUSREORD job raises purchase orders for low stock, and the VENDSIM
// job plays the vendors' side.

import { EdiError, interchange, OUR_ID, processInterchange, receive, send, ymd, type Interchange } from "./edi";
import { HttpError } from "./http";
import type { StepResult } from "./jobs";

export interface Vendor {
	id: string;
	name: string;
	city: string;
	state: string;
	lead_days: number;
	status: "A" | "I";
	open_pos?: number; // POs not yet received, in listVendors
	products?: number; // products it supplies, in listVendors
}

export interface PurchaseOrder {
	id: string;
	vendor_id: string;
	status: "O" | "S" | "A" | "T" | "R";
	total: number;
	origin: string;
	ship_date: string;
	created: string;
	created_by: string;
	sent: string;
	received: string;
}

export interface POLine {
	po_id: string;
	line: number;
	sku: string;
	description: string;
	quantity: number;
	unit_cost: number;
	received: number;
}

export const poStatusNames: Record<string, string> = {
	O: "OPEN", S: "SENT", A: "CONFIRMED", T: "IN TRANSIT", R: "RECEIVED",
};

const MAX_QTY = 99_999;

const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
const now = () => new Date().toISOString();

// ---- vendors ----

export async function listVendors(db: D1Database): Promise<Vendor[]> {
	const { results } = await db.prepare(
		`SELECT v.*,
		   (SELECT COUNT(*) FROM purchase_orders WHERE vendor_id = v.id AND status <> 'R') AS open_pos,
		   (SELECT COUNT(*) FROM products WHERE vendor = v.id) AS products
		 FROM vendors v ORDER BY v.id`,
	).all<Vendor>();
	return results;
}

export async function getVendor(db: D1Database, id: string): Promise<Vendor> {
	const row = await db.prepare("SELECT * FROM vendors WHERE id = ?").bind(id.trim().toUpperCase()).first<Vendor>();
	if (!row) throw new HttpError(404, "not_found", "vendor not found");
	return row;
}

// ---- purchase orders ----

// createPO opens a new, empty purchase order with an active vendor.
export async function createPO(db: D1Database, user: string, vendorId: string, origin = ""): Promise<PurchaseOrder> {
	vendorId = vendorId.trim().toUpperCase();
	if (!vendorId) throw bad("vendor", "enter a vendor number");
	const v = await db.prepare("SELECT status FROM vendors WHERE id = ?").bind(vendorId).first<{ status: string }>();
	if (!v) throw bad("vendor", `vendor ${vendorId} is not on file`);
	if (v.status !== "A") throw bad("vendor", `vendor ${vendorId} is inactive - no new orders`);
	const [, inserted] = await db.batch<PurchaseOrder>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'po_id'"),
		db.prepare(
			`INSERT INTO purchase_orders (id, vendor_id, status, origin, created, created_by)
			 SELECT printf('PO%05d', value), ?, 'O', ?, ?, ? FROM counters WHERE name = 'po_id'
			 RETURNING *`,
		).bind(vendorId, origin, now(), user),
	]);
	return inserted.results[0];
}

// listPOs returns purchase orders newest first, for one vendor or all.
export async function listPOs(db: D1Database, vendorId = ""): Promise<PurchaseOrder[]> {
	const { results } = await db.prepare(
		"SELECT * FROM purchase_orders WHERE ?1 = '' OR vendor_id = ?1 ORDER BY id DESC LIMIT 500",
	).bind(vendorId.trim().toUpperCase()).all<PurchaseOrder>();
	return results;
}

export async function getPO(db: D1Database, id: string): Promise<{ po: PurchaseOrder; lines: POLine[] }> {
	const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").bind(id).first<PurchaseOrder>();
	if (!po) throw new HttpError(404, "not_found", "purchase order not found");
	const { results } = await db.prepare("SELECT * FROM po_lines WHERE po_id = ? ORDER BY line").bind(id).all<POLine>();
	return { po, lines: results };
}

const isOpen = "EXISTS (SELECT 1 FROM purchase_orders WHERE id = ?1 AND status = 'O')";
const retotal = (db: D1Database, id: string) => db.prepare(
	`UPDATE purchase_orders SET total = (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM po_lines WHERE po_id = ?1)
	 WHERE id = ?1 AND status = 'O'`,
).bind(id);

async function mustBeOpen(db: D1Database, id: string): Promise<PurchaseOrder> {
	const { po } = await getPO(db, id);
	if (po.status !== "O") throw bad("sku", `purchase order ${id} is ${poStatusNames[po.status].toLowerCase()} - it can no longer be changed`);
	return po;
}

// addPOLine adds a product the vendor supplies to an open purchase order,
// at the product's unit cost.
export async function addPOLine(db: D1Database, id: string, sku: string, qty: number): Promise<POLine> {
	sku = sku.trim().toUpperCase();
	if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw bad("qty", "quantity must be a whole number from 1 to 99999");
	const [inserted] = await db.batch<POLine>([
		db.prepare(
			`INSERT INTO po_lines (po_id, line, sku, description, quantity, unit_cost)
			 SELECT ?1, (SELECT COALESCE(MAX(line), 0) + 1 FROM po_lines WHERE po_id = ?1), sku, description, ?3, unit_cost
			 FROM products WHERE sku = ?2 AND status = 'A'
			   AND vendor = (SELECT vendor_id FROM purchase_orders WHERE id = ?1 AND status = 'O')
			 RETURNING *`,
		).bind(id, sku, qty),
		retotal(db, id),
	]);
	const row = inserted.results[0];
	if (row) return row;

	const po = await mustBeOpen(db, id);
	const p = await db.prepare("SELECT status, vendor FROM products WHERE sku = ?").bind(sku).first<{ status: string; vendor: string }>();
	if (!p) throw bad("sku", `product ${sku} is not on file`);
	if (p.status !== "A") throw bad("sku", `product ${sku} is discontinued`);
	throw bad("sku", `${sku} is supplied by ${p.vendor || "no vendor"}, not ${po.vendor_id}`);
}

// deletePOLine removes a line from an open purchase order.
export async function deletePOLine(db: D1Database, id: string, line: number): Promise<void> {
	const [deleted] = await db.batch([
		db.prepare(`DELETE FROM po_lines WHERE po_id = ?1 AND line = ?2 AND ${isOpen}`).bind(id, line),
		retotal(db, id),
	]);
	if (deleted.meta.changes === 1) return;
	await mustBeOpen(db, id);
	throw new HttpError(404, "not_found", "purchase order line not found");
}

// cancelPO deletes an open purchase order.
export async function cancelPO(db: D1Database, id: string): Promise<void> {
	const [, deleted] = await db.batch([
		db.prepare(`DELETE FROM po_lines WHERE po_id = ?1 AND ${isOpen}`).bind(id),
		db.prepare("DELETE FROM purchase_orders WHERE id = ? AND status = 'O'").bind(id),
	]);
	if (deleted.meta.changes === 1) return;
	await mustBeOpen(db, id);
}

// sendPO sends an open purchase order with at least one line to its vendor
// as an 850.
export async function sendPO(db: D1Database, id: string): Promise<{ po: PurchaseOrder; edi: Interchange }> {
	const po = await db.prepare(
		`UPDATE purchase_orders SET status = 'S', sent = ?2
		 WHERE id = ?1 AND status = 'O' AND EXISTS (SELECT 1 FROM po_lines WHERE po_id = ?1) RETURNING *`,
	).bind(id, now()).first<PurchaseOrder>();
	if (!po) {
		await mustBeOpen(db, id);
		throw bad("sku", "add at least one line before sending");
	}
	const { lines } = await getPO(db, id);
	const v = await getVendor(db, po.vendor_id);
	const edi = await send(db, po.vendor_id, "850", [
		["BEG", "00", "NE", po.id, "", ymd(new Date(po.sent))],
		["N1", "VN", v.name, "92", v.id],
		...lines.map((l) => ["PO1", l.line, l.quantity, "EA", l.unit_cost, "", "VP", l.sku]),
		["CTT", lines.length],
	], po.id);
	return { po, edi };
}

// receivePO receives goods against a sent purchase order: qty maps line
// numbers to the quantity that came in, or is "all" for everything still
// due. Each receipt goes into stock. It returns the PO and the number of
// units received.
export async function receivePO(
	db: D1Database, user: string, id: string, qty: Map<number, number> | "all",
): Promise<{ po: PurchaseOrder; units: number }> {
	const { po, lines } = await getPO(db, id);
	if (po.status === "O") throw bad("rcv", `purchase order ${id} has not been sent`);
	if (po.status === "R") throw bad("rcv", `purchase order ${id} is already received`);
	const due = new Map(lines.map((l) => [l.line, l]));
	const wanted = qty === "all"
		? new Map(lines.filter((l) => l.received < l.quantity).map((l) => [l.line, l.quantity - l.received]))
		: qty;
	for (const [line, n] of wanted) {
		const l = due.get(line);
		if (!l) throw new HttpError(404, "not_found", "purchase order line not found");
		if (!Number.isInteger(n) || n < 1) throw bad(`rcv:${line}`, "quantity received must be a whole number above zero");
		if (n > l.quantity - l.received) throw bad(`rcv:${line}`, `line ${line} has only ${l.quantity - l.received} still due`);
	}

	const ts = now();
	const stmts: D1PreparedStatement[] = [];
	for (const [line, n] of wanted) {
		const l = due.get(line)!;
		// The receipt and the stock follow the line, and only if the line
		// still had that much due.
		stmts.push(
			db.prepare(
				`UPDATE po_lines SET received = received + ?3 WHERE po_id = ?1 AND line = ?2 AND received = ?4
				   AND EXISTS (SELECT 1 FROM purchase_orders WHERE id = ?1 AND status IN ('S', 'A', 'T'))`,
			).bind(id, line, n, l.received),
			db.prepare("UPDATE products SET on_hand = on_hand + ?, version = version + 1 WHERE sku = ? AND changes() = 1").bind(n, l.sku),
			db.prepare(
				"INSERT INTO receipts (po_id, line, sku, quantity, unit_cost, at, by) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1",
			).bind(id, line, l.sku, n, l.unit_cost, ts, user),
		);
	}
	stmts.push(db.prepare(
		`UPDATE purchase_orders SET status = 'R', received = ?2
		 WHERE id = ?1 AND status IN ('S', 'A', 'T') AND NOT EXISTS (SELECT 1 FROM po_lines WHERE po_id = ?1 AND received < quantity)`,
	).bind(id, ts));
	const results = await db.batch(stmts);
	let units = 0;
	[...wanted.values()].forEach((n, i) => {
		if (results[i * 3 + 2].meta.changes === 1) units += n;
	});
	if (units === 0 && wanted.size > 0) throw new HttpError(409, "conflict", "record was changed by another user");
	return { po: (await getPO(db, id)).po, units };
}

// onOrder returns how many of a product are on purchase orders not yet
// received.
export async function onOrder(db: D1Database, sku: string): Promise<number> {
	const row = await db.prepare(
		`SELECT COALESCE(SUM(l.quantity - l.received), 0) AS n FROM po_lines l
		 JOIN purchase_orders p ON p.id = l.po_id WHERE l.sku = ? AND p.status <> 'R'`,
	).bind(sku).first<{ n: number }>();
	return row?.n ?? 0;
}

// ---- EDI from vendors ----

const seg = (body: string[][], id: string) => body.filter((s) => s[0] === id);

// vendorDocument applies an interchange from a vendor's system: an 855
// confirms a sent purchase order, an 856 puts it in transit. It returns the
// PO number.
export async function vendorDocument(db: D1Database, vendor: string, type: string, body: string[][]): Promise<string> {
	const v = await db.prepare("SELECT 1 FROM vendors WHERE id = ?").bind(vendor).first();
	if (!v) throw new EdiError(`sender ${vendor} is not a vendor on file`);
	if (type !== "855" && type !== "856") throw new EdiError(`transaction set ${type || "(blank)"} is not accepted from vendors`);

	const id = ((type === "855" ? seg(body, "BAK")[0]?.[3] : seg(body, "PRF")[0]?.[1]) ?? "").trim().toUpperCase();
	const why = (msg: string) => Object.assign(new EdiError(msg), { reference: id });
	if (!id) throw new EdiError(type === "855" ? "BAK03 purchase order number is missing" : "PRF01 purchase order number is missing");
	const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").bind(id).first<PurchaseOrder>();
	if (!po || po.vendor_id !== vendor) throw why(`purchase order ${id} was not sent to ${vendor}`);

	if (type === "855") {
		if (po.status !== "S") throw why(`purchase order ${id} is ${poStatusNames[po.status].toLowerCase()}, not awaiting confirmation`);
		const dtm = (seg(body, "DTM").find((s) => s[1] === "068")?.[2] ?? "").trim();
		const shipDate = /^\d{8}$/.test(dtm) ? `${dtm.slice(0, 4)}-${dtm.slice(4, 6)}-${dtm.slice(6)}` : "";
		await db.prepare("UPDATE purchase_orders SET status = 'A', ship_date = ? WHERE id = ? AND status = 'S'").bind(shipDate, id).run();
	} else {
		if (po.status !== "S" && po.status !== "A") throw why(`purchase order ${id} is ${poStatusNames[po.status].toLowerCase()}, not awaiting shipment`);
		await db.prepare("UPDATE purchase_orders SET status = 'T' WHERE id = ? AND status IN ('S', 'A')").bind(id).run();
	}
	return id;
}

// ---- batch job steps ----

const pad = (s: string | number, n: number, left = false) => {
	const v = String(s).slice(0, n);
	return left ? v.padStart(n) : v.padEnd(n);
};

// reorder is CUSREORD's step: every active product at or below its reorder
// point is ordered back up to twice its reorder point, counting what is
// already on order, on one purchase order per vendor, and the orders are
// sent. A re-run finds the stock on order and orders nothing twice.
export async function reorder(db: D1Database, job: { id: string; name: string }): Promise<StepResult> {
	const { results } = await db.prepare(
		`SELECT p.sku, p.description, p.on_hand, p.reorder_point, p.vendor,
		   (SELECT COALESCE(SUM(l.quantity - l.received), 0) FROM po_lines l JOIN purchase_orders o ON o.id = l.po_id
		    WHERE l.sku = p.sku AND o.status <> 'R') AS on_order
		 FROM products p WHERE p.status = 'A' AND p.reorder_point > 0 AND p.on_hand <= p.reorder_point ORDER BY p.vendor, p.sku`,
	).all<{ sku: string; description: string; on_hand: number; reorder_point: number; vendor: string; on_order: number }>();

	const lines = [
		"",
		"LOW STOCK                                     ON HAND  REORDER  ON ORDER   ORDER  PO",
		"---------- ------------------------------ -------- -------- -------- ------- -------",
	];
	let warn = false;
	let orders = 0;
	const byVendor = new Map<string, { sku: string; qty: number; row: string }[]>();
	for (const p of results) {
		const qty = p.reorder_point * 2 - p.on_hand - p.on_order;
		const row = `${pad(p.sku, 10)} ${pad(p.description, 30)} ${pad(p.on_hand, 8, true)} ${pad(p.reorder_point, 8, true)} ${pad(p.on_order, 8, true)}`;
		if (qty <= 0 || p.on_hand + p.on_order > p.reorder_point) {
			lines.push(`${row} ${pad("-", 7, true)} ON ORDER`);
		} else if (!p.vendor) {
			lines.push(`${row} ${pad(qty, 7, true)} NO VENDOR - NOT ORDERED`);
			warn = true;
		} else {
			byVendor.set(p.vendor, [...(byVendor.get(p.vendor) ?? []), { sku: p.sku, qty, row }]);
		}
	}
	for (const [vendor, items] of byVendor) {
		const po = await createPO(db, job.name, vendor, job.name);
		for (const it of items) {
			await addPOLine(db, po.id, it.sku, it.qty);
			lines.push(`${it.row} ${pad(it.qty, 7, true)} ${po.id}`);
		}
		const sent = await sendPO(db, po.id);
		lines.push(`${"".padEnd(10)} ${vendor} ${sent.po.id} SENT AS 850 ${sent.edi.id}, ${"$" + sent.po.total.toLocaleString("en-US")} AT COST`);
		orders++;
	}
	if (results.length === 0) lines.push("  NO PRODUCTS AT OR BELOW THEIR REORDER POINT");
	lines.push("", `${results.length} PRODUCTS LOW, ${orders} PURCHASE ORDERS SENT`);
	return { rc: warn ? 4 : 0, lines };
}

// The vendors' side, for the simulator.

// vendorConfirmation builds the 855 a vendor's system sends for a PO.
export function vendorConfirmation(vendor: string, control: number, po: string, shipDate: Date): string {
	const at = new Date();
	return interchange(vendor, OUR_ID, control, "855", [
		["BAK", "00", "AC", po, ymd(at)],
		["DTM", "068", ymd(shipDate)],
	], at);
}

// vendorShipNotice builds the 856 a vendor's system sends when it ships.
export function vendorShipNotice(vendor: string, control: number, po: string): string {
	const at = new Date();
	return interchange(vendor, OUR_ID, control, "856", [
		["BSN", "00", `ASN${control}`, ymd(at), ymd(at).slice(4)],
		["HL", "1", "", "S"],
		["PRF", po],
	], at);
}

async function vendorsSend(
	db: D1Database, job: { id: string }, status: "S" | "A", seq: number,
	build: (po: PurchaseOrder & { lead_days: number }, control: number) => string,
): Promise<string[]> {
	const { results } = await db.prepare(
		"SELECT p.*, v.lead_days FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.status = ? ORDER BY p.id LIMIT 50",
	).bind(status).all<PurchaseOrder & { lead_days: number }>();
	const out: string[] = [];
	for (const [i, po] of results.entries()) {
		const filed = await receive(db, "VENDSIM", build(po, Number(job.id.slice(3)) * 1000 + seq * 100 + i));
		const done = (await processInterchange(db, filed.id))!;
		out.push(`  ${filed.id} ${po.vendor_id} ${po.id} ${done.status.padEnd(9)} ${done.note}`.trimEnd());
	}
	return out;
}

// vendorsConfirm is VENDSIM's first step: each vendor confirms the POs we
// sent it with an 855, promising shipment after its lead time.
export async function vendorsConfirm(db: D1Database, job: { id: string }): Promise<StepResult> {
	const sent = await vendorsSend(db, job, "S", 1, (po, control) =>
		vendorConfirmation(po.vendor_id, control, po.id, new Date(Date.now() + po.lead_days * 86_400_000)));
	return { rc: 0, lines: ["", "PURCHASE ORDERS CONFIRMED (855):", ...(sent.length ? sent : ["  NO SENT PURCHASE ORDERS"])] };
}

// vendorsShip is VENDSIM's second step: each vendor ships the confirmed
// POs and sends an 856 ship notice. Receiving them is up to us.
export async function vendorsShip(db: D1Database, job: { id: string }): Promise<StepResult> {
	const sent = await vendorsSend(db, job, "A", 2, (po, control) => vendorShipNotice(po.vendor_id, control, po.id));
	return { rc: 0, lines: ["", "PURCHASE ORDERS SHIPPED (856):", ...(sent.length ? sent : ["  NO CONFIRMED PURCHASE ORDERS"])] };
}
