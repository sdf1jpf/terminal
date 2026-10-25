// Invoices with line items, shared by the REST endpoints (index.ts) and the
// screens (screens/invoices.ts).
//
// An invoice is OPEN (O) while it is being built. Adding a line takes the
// quantity out of stock at the product's current price; changing or
// removing a line moves the difference back. Billing (B) posts the total to
// the customer's account as an invoice transaction and freezes the lines.
// Marking it paid (P) posts the payment.
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
}

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

// createInvoice opens a new, empty invoice for an active customer.
export async function createInvoice(db: D1Database, user: string, customerId: string, po = ""): Promise<Invoice> {
	po = po.trim().toUpperCase();
	if (po.length > 22) throw bad("po", "PO number is limited to 22 characters");
	const cust = await db.prepare("SELECT status FROM customers WHERE id = ?").bind(customerId).first<{ status: string }>();
	if (!cust) throw new HttpError(404, "not_found", "record not found");
	if (cust.status !== "A") throw bad("id", `customer is ${cust.status === "H" ? "on hold" : "closed"} - no new invoices`);
	const [, inserted] = await db.batch<Invoice>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'invoice_id'"),
		db.prepare(
			`INSERT INTO invoices (id, customer_id, status, po_number, created, created_by)
			 SELECT printf('INV%05d', value), ?, 'O', ?, ?, ? FROM counters WHERE name = 'invoice_id'
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
	const row = await db.prepare("UPDATE invoices SET po_number = ?2 WHERE id = ?1 AND status = 'O' RETURNING *")
		.bind(id, po).first<Invoice>();
	if (row) return row;
	await mustBeOpen(db, id);
	throw new HttpError(409, "conflict", "record was changed by another user");
}

function checkQty(qty: number): void {
	if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw bad("qty", "quantity must be a whole number from 1 to 99999");
}

const isOpen = "EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND status = 'O')";
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
		db.prepare("DELETE FROM invoices WHERE id = ? AND status = 'O'").bind(id),
	]);
	if (deleted.meta.changes === 1) return;
	await mustBeOpen(db, id);
}

// billInvoice posts an open invoice's total to its customer's account. The
// invoice needs at least one line and an active customer.
export async function billInvoice(db: D1Database, user: string, id: string): Promise<{ invoice: Invoice; transaction: Transaction }> {
	const ready = `EXISTS (SELECT 1 FROM invoices i JOIN customers c ON c.id = i.customer_id
	                       WHERE i.id = ?1 AND i.status = 'O' AND c.status = 'A')
	               AND EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = ?1)`;
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
