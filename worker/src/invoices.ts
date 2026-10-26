// Invoices with line items, shared by the REST endpoints (index.ts) and the
// screens (screens/invoices.ts).
//
// An invoice is OPEN (O) while it is being built. Adding a line takes the
// quantity out of stock at the product's current price; changing or
// removing a line moves the difference back. Releasing it to the warehouse
// (shipping.ts) freezes the lines, and only a shipped invoice can be billed.
// Billing (B) posts the total to the customer's account as an invoice
// transaction. Marking it paid (P) posts the payment.
//
// Each invoice carries its own bill-to and ship-to address, copied from the
// customer when it is opened. The ship-to can be changed until the invoice
// is released to the warehouse, the bill-to until it is billed.
//
// Each change is one D1 batch, which runs as one transaction. Statements
// that must happen together carry the same guard, evaluated against the
// same state, or follow on with `changes() = 1`, which in SQLite is the
// number of rows the statement before it changed.

import { HttpError } from "./http";
import type { Transaction } from "./activity";

export interface Invoice {
	id: string;
	customer_id: string;
	status: "O" | "B" | "P";
	po_number: string;
	total: number;
	created: string;
	created_by: string;
	billed: string;
	paid: string;
	bill_name: string;
	bill_address: string;
	bill_city: string;
	bill_state: string;
	bill_zip: string;
	ship_name: string;
	ship_address: string;
	ship_city: string;
	ship_state: string;
	ship_zip: string;
}

export interface Address {
	name: string;
	address: string;
	city: string;
	state: string;
	zip: string;
}

export type AddressKind = "bill" | "ship";

// addressOf returns an invoice's bill-to or ship-to address.
export function addressOf<K extends AddressKind>(inv: Record<`${K}_${keyof Address}`, string>, kind: K): Address {
	return {
		name: inv[`${kind}_name`], address: inv[`${kind}_address`], city: inv[`${kind}_city`],
		state: inv[`${kind}_state`], zip: inv[`${kind}_zip`],
	};
}

// cityLine is the last line of an address: CITY, ST 12345.
export const cityLine = (a: Address) => (a.city ? `${a.city}, ${a.state} ${a.zip}` : "");

export interface InvoiceLine {
	invoice_id: string;
	line: number;
	sku: string;
	description: string;
	quantity: number;
	unit_price: number;
}

export const statusNames: Record<string, string> = { O: "OPEN", B: "BILLED", P: "PAID" };

const MAX_QTY = 99_999;

const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
const now = () => new Date().toISOString();

// createInvoice opens a new, empty invoice for an active customer, billed
// and shipped to the customer's address.
export async function createInvoice(db: D1Database, user: string, customerId: string, po = ""): Promise<Invoice> {
	po = po.trim().toUpperCase();
	if (po.length > 22) throw bad("po", "PO number is limited to 22 characters");
	const cust = await db.prepare("SELECT status FROM customers WHERE id = ?").bind(customerId).first<{ status: string }>();
	if (!cust) throw new HttpError(404, "not_found", "record not found");
	if (cust.status !== "A") throw bad("id", `customer is ${cust.status === "H" ? "on hold" : "closed"} - no new invoices`);
	const [, inserted] = await db.batch<Invoice>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'invoice_id'"),
		db.prepare(
			`INSERT INTO invoices (id, customer_id, status, po_number, created, created_by,
			                      bill_name, bill_address, bill_city, bill_state, bill_zip,
			                      ship_name, ship_address, ship_city, ship_state, ship_zip)
			 SELECT printf('INV%05d', n.value), c.id, 'O', ?2, ?3, ?4,
			        c.name, c.address, c.city, c.state, c.zip, c.name, c.address, c.city, c.state, c.zip
			 FROM counters n, customers c WHERE n.name = 'invoice_id' AND c.id = ?1
			 RETURNING *`,
		).bind(customerId, po, now(), user),
	]);
	return inserted.results[0];
}

// listInvoices returns invoices newest first, for one customer or all.
export async function listInvoices(db: D1Database, customerId = ""): Promise<Invoice[]> {
	const { results } = await db.prepare(
		"SELECT * FROM invoices WHERE ?1 = '' OR customer_id = ?1 ORDER BY id DESC LIMIT 500",
	).bind(customerId).all<Invoice>();
	return results;
}

export async function getInvoice(db: D1Database, id: string): Promise<{ invoice: Invoice; lines: InvoiceLine[] }> {
	const invoice = await db.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first<Invoice>();
	if (!invoice) throw new HttpError(404, "not_found", "invoice not found");
	const { results } = await db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line")
		.bind(id).all<InvoiceLine>();
	return { invoice, lines: results };
}

// setPO changes an open invoice's purchase order number.
export async function setPO(db: D1Database, id: string, po: string): Promise<Invoice> {
	po = po.trim().toUpperCase();
	if (po.length > 22) throw bad("po", "PO number is limited to 22 characters");
	const row = await db.prepare(`UPDATE invoices SET po_number = ?2 WHERE id = ?1 AND ${isOpen} RETURNING *`)
		.bind(id, po).first<Invoice>();
	if (row) return row;
	await mustBeOpen(db, id);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

const reState = /^[A-Z]{2}$/;
const reZip = /^[0-9]{5}$/;

// checkAddress normalizes an address and applies the customer file's rules
// to it. Its errors name the screen's fields: bname, baddr, bcity, bstate
// and bzip for the bill-to, sname and so on for the ship-to.
export function checkAddress(kind: AddressKind, a: Address): Address {
	const up = (v: string) => (v ?? "").trim().toUpperCase();
	const out = { name: up(a.name), address: up(a.address), city: up(a.city), state: up(a.state), zip: up(a.zip) };
	const f = kind[0];
	const what = kind === "bill" ? "bill-to" : "ship-to";
	if (out.name === "") throw bad(f + "name", `${what} name is required`);
	if (out.name.length > 30) throw bad(f + "name", `${what} name is limited to 30 characters`);
	if (out.address.length > 30) throw bad(f + "addr", `${what} address is limited to 30 characters`);
	if (out.city === "") throw bad(f + "city", `${what} city is required`);
	if (out.city.length > 18) throw bad(f + "city", `${what} city is limited to 18 characters`);
	if (!reState.test(out.state)) throw bad(f + "state", `${what} state must be a two letter code`);
	if (!reZip.test(out.zip)) throw bad(f + "zip", `${what} zip code must be five digits`);
	return out;
}

// setAddress changes an invoice's bill-to or ship-to address. The ship-to
// is frozen once the invoice is released to the warehouse, which has
// printed it on the pick ticket; the bill-to once it is billed.
export async function setAddress(db: D1Database, id: string, kind: AddressKind, a: Address): Promise<Invoice> {
	const v = checkAddress(kind, a);
	const guard = kind === "ship" ? isOpen : "EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND status = 'O')";
	const row = await db.prepare(
		`UPDATE invoices SET ${kind}_name = ?2, ${kind}_address = ?3, ${kind}_city = ?4, ${kind}_state = ?5, ${kind}_zip = ?6
		 WHERE id = ?1 AND ${guard} RETURNING *`,
	).bind(id, v.name, v.address, v.city, v.state, v.zip).first<Invoice>();
	if (row) return row;
	const { invoice } = await getInvoice(db, id);
	const field = kind[0] + "name";
	if (invoice.status !== "O") {
		throw bad(field, `invoice ${id} is ${statusNames[invoice.status].toLowerCase()} - its addresses can no longer be changed`);
	}
	const shp = await db.prepare("SELECT id FROM shipments WHERE invoice_id = ?").bind(id).first<{ id: string }>();
	if (shp) throw bad(field, `invoice ${id} is released to the warehouse on ${shp.id} - cancel the shipment to change the ship-to`);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

function checkQty(qty: number): void {
	if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw bad("qty", "quantity must be a whole number from 1 to 99999");
}

// isOpen: the invoice can still be changed, that is it is open and not yet
// released to the warehouse.
const isOpen = `EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND status = 'O')
                AND NOT EXISTS (SELECT 1 FROM shipments WHERE invoice_id = ?1)`;
const retotal = (db: D1Database, id: string) => db.prepare(
	`UPDATE invoices SET total = (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_lines WHERE invoice_id = ?1)
	 WHERE id = ?1 AND status = 'O'`,
).bind(id);

// mustBeOpen explains why an invoice change did nothing.
async function mustBeOpen(db: D1Database, id: string): Promise<void> {
	const { invoice } = await getInvoice(db, id);
	if (invoice.status !== "O") {
		throw bad("sku", `invoice ${id} is ${statusNames[invoice.status].toLowerCase()} - it can no longer be changed`);
	}
	const shp = await db.prepare("SELECT id FROM shipments WHERE invoice_id = ?").bind(id).first<{ id: string }>();
	if (shp) throw bad("sku", `invoice ${id} is released to the warehouse on ${shp.id} - cancel the shipment to change it`);
}

// addLine adds a product to an open invoice at its current price and takes
// the quantity out of stock.
export async function addLine(db: D1Database, id: string, sku: string, qty: number): Promise<InvoiceLine> {
	sku = sku.trim().toUpperCase();
	checkQty(qty);
	const sellable = "sku = ?2 AND status = 'A' AND on_hand >= ?3";
	const [inserted] = await db.batch<InvoiceLine>([
		db.prepare(
			`INSERT INTO invoice_lines (invoice_id, line, sku, description, quantity, unit_price)
			 SELECT ?1, (SELECT COALESCE(MAX(line), 0) + 1 FROM invoice_lines WHERE invoice_id = ?1),
			        sku, description, ?3, unit_price
			 FROM products WHERE ${sellable} AND ${isOpen}
			 RETURNING *`,
		).bind(id, sku, qty),
		db.prepare(`UPDATE products SET on_hand = on_hand - ?3, version = version + 1 WHERE ${sellable} AND changes() = 1`)
			.bind(id, sku, qty),
		retotal(db, id),
	]);
	const row = inserted.results[0];
	if (row) return row;

	await mustBeOpen(db, id);
	const p = await db.prepare("SELECT status, on_hand FROM products WHERE sku = ?").bind(sku).first<{ status: string; on_hand: number }>();
	if (!p) throw bad("sku", `product ${sku} is not on file`);
	if (p.status !== "A") throw bad("sku", `product ${sku} is discontinued`);
	throw bad("qty", `only ${p.on_hand} of ${sku} on hand`);
}

// changeLine sets a line's quantity, moving the difference to or from stock.
export async function changeLine(db: D1Database, id: string, line: number, qty: number): Promise<InvoiceLine> {
	checkQty(qty);
	const old = await db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? AND line = ?").bind(id, line).first<InvoiceLine>();
	if (!old) throw new HttpError(404, "not_found", "invoice line not found");
	const delta = qty - old.quantity;
	if (delta === 0) return old;
	const [updated] = await db.batch<InvoiceLine>([
		db.prepare(
			`UPDATE invoice_lines SET quantity = ?3
			 WHERE invoice_id = ?1 AND line = ?2 AND quantity = ?4 AND ${isOpen}
			   AND (?5 <= 0 OR (SELECT on_hand FROM products WHERE sku = ?6) >= ?5)
			 RETURNING *`,
		).bind(id, line, qty, old.quantity, delta, old.sku),
		db.prepare("UPDATE products SET on_hand = on_hand - ?, version = version + 1 WHERE sku = ? AND changes() = 1")
			.bind(delta, old.sku),
		retotal(db, id),
	]);
	const row = updated.results[0];
	if (row) return row;

	await mustBeOpen(db, id);
	const p = await db.prepare("SELECT on_hand FROM products WHERE sku = ?").bind(old.sku).first<{ on_hand: number }>();
	if (p && p.on_hand < delta) throw bad("qty", `only ${p.on_hand} more of ${old.sku} on hand`);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

// deleteLine removes a line from an open invoice and returns its stock.
export async function deleteLine(db: D1Database, id: string, line: number): Promise<void> {
	const old = await db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? AND line = ?").bind(id, line).first<InvoiceLine>();
	if (!old) throw new HttpError(404, "not_found", "invoice line not found");
	const [deleted] = await db.batch([
		db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?1 AND line = ?2 AND quantity = ?3 AND ${isOpen}`)
			.bind(id, line, old.quantity),
		db.prepare("UPDATE products SET on_hand = on_hand + ?, version = version + 1 WHERE sku = ? AND changes() = 1")
			.bind(old.quantity, old.sku),
		retotal(db, id),
	]);
	if (deleted.meta.changes === 1) return;
	await mustBeOpen(db, id);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

// cancelInvoice deletes an open invoice and returns all its stock.
export async function cancelInvoice(db: D1Database, id: string): Promise<void> {
	const [, , deleted] = await db.batch([
		db.prepare(
			`UPDATE products SET version = version + 1,
			     on_hand = on_hand + (SELECT SUM(quantity) FROM invoice_lines WHERE invoice_id = ?1 AND sku = products.sku)
			 WHERE sku IN (SELECT sku FROM invoice_lines WHERE invoice_id = ?1) AND ${isOpen}`,
		).bind(id),
		db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?1 AND ${isOpen}`).bind(id),
		db.prepare(`DELETE FROM invoices WHERE id = ?1 AND ${isOpen}`).bind(id),
	]);
	// The count includes the order signal its trigger adds (lifecycle.ts).
	if (deleted.meta.changes > 0) return;
	await mustBeOpen(db, id);
}

// billInvoice posts an open invoice's total to its customer's account. The
// invoice must have shipped, and its customer must be active.
export async function billInvoice(db: D1Database, user: string, id: string): Promise<{ invoice: Invoice; transaction: Transaction }> {
	const ready = `EXISTS (SELECT 1 FROM invoices i JOIN customers c ON c.id = i.customer_id
	                       WHERE i.id = ?1 AND i.status = 'O' AND c.status = 'A')
	               AND EXISTS (SELECT 1 FROM shipments WHERE invoice_id = ?1 AND status = 'S')`;
	const ts = now();
	const [, posted, billed] = await db.batch<any>([
		db.prepare(
			`UPDATE customers SET balance = balance + (SELECT total FROM invoices WHERE id = ?1)
			 WHERE id = (SELECT customer_id FROM invoices WHERE id = ?1) AND ${ready}`,
		).bind(id),
		db.prepare(
			`INSERT INTO transactions (customer_id, type, amount, reference, balance, posted, posted_by)
			 SELECT i.customer_id, 'I', i.total, i.id, c.balance, ?2, ?3
			 FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?1 AND ${ready}
			 RETURNING *`,
		).bind(id, ts, user),
		db.prepare(`UPDATE invoices SET status = 'B', billed = ?2 WHERE id = ?1 AND ${ready} RETURNING *`).bind(id, ts),
	]);
	if (billed.results[0]) return { invoice: billed.results[0], transaction: posted.results[0] };

	const { invoice, lines } = await getInvoice(db, id);
	if (invoice.status !== "O") throw bad("sku", `invoice ${id} is already ${statusNames[invoice.status].toLowerCase()}`);
	if (lines.length === 0) throw bad("sku", "add at least one line before billing");
	const shp = await db.prepare("SELECT id, status FROM shipments WHERE invoice_id = ?").bind(id).first<{ id: string; status: string }>();
	if (!shp) throw bad("sku", `invoice ${id} has not shipped - release it to the warehouse first`);
	if (shp.status !== "S") throw bad("sku", `invoice ${id} has not shipped - ${shp.id} is still in the warehouse`);
	throw bad("sku", `customer ${invoice.customer_id} is not active - the invoice cannot be billed`);
}

// payInvoice marks a billed invoice paid, posting a payment for its total.
export async function payInvoice(db: D1Database, user: string, id: string): Promise<{ invoice: Invoice; transaction: Transaction }> {
	const billed = "EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND status = 'B')";
	const ts = now();
	const [, posted, paid] = await db.batch<any>([
		db.prepare(
			`UPDATE customers SET balance = balance - (SELECT total FROM invoices WHERE id = ?1)
			 WHERE id = (SELECT customer_id FROM invoices WHERE id = ?1) AND ${billed}`,
		).bind(id),
		db.prepare(
			`INSERT INTO transactions (customer_id, type, amount, reference, balance, posted, posted_by)
			 SELECT i.customer_id, 'P', i.total, i.id, c.balance, ?2, ?3
			 FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?1 AND ${billed}
			 RETURNING *`,
		).bind(id, ts, user),
		db.prepare(`UPDATE invoices SET status = 'P', paid = ?2 WHERE id = ?1 AND ${billed} RETURNING *`).bind(id, ts),
	]);
	if (paid.results[0]) return { invoice: paid.results[0], transaction: posted.results[0] };
	const { invoice } = await getInvoice(db, id);
	throw bad("sku", invoice.status === "P" ? `invoice ${id} is already paid` : `invoice ${id} must be billed before it is paid`);
}
