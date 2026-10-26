// EDI exceptions. A customer's 850 line whose product is missing, not on
// file or discontinued no longer rejects the order: the rest of the order
// becomes an invoice as usual, and the line is held here for an operator.
// The operator corrects it to a product we carry, which adds it to the
// invoice for the quantity ordered, or drops it, or rejects the whole order,
// which cancels the invoice. The invoice cannot be released to the
// warehouse while any of its lines are held, and its lifecycle waits for
// them (lifecycle.ts): the triggers in migration 0028 signal each change.

import type { Interchange } from "./edi";
import { HttpError } from "./http";
import { addLine, cancelInvoice, type Invoice, type InvoiceLine } from "./invoices";
import { logStmt } from "./syslog";

export interface EdiException {
	seq: number;
	edi_id: string; // the 850
	invoice_id: string;
	customer_id: string;
	po_number: string;
	po_line: string; // the PO1 line number, as sent
	sku: string; // as sent; "" if the line had no product ID
	quantity: number;
	unit_price: number; // as sent
	problem: string;
	status: "O" | "C" | "D" | "X"; // open, corrected, dropped, order rejected
	corrected_sku: string;
	line: number | null; // the invoice line a correction became
	created: string;
	resolved: string;
	resolved_by: string;
}

export const exceptionStatusNames: Record<EdiException["status"], string> = {
	O: "OPEN", C: "CORRECTED", D: "DROPPED", X: "REJECTED",
};

const now = () => new Date().toISOString();
const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);

// holdLines records an 850's held lines.
export async function holdLines(
	db: D1Database,
	inbound: Interchange,
	inv: Invoice,
	lines: Pick<EdiException, "po_line" | "sku" | "quantity" | "unit_price" | "problem">[],
): Promise<void> {
	const ts = now();
	await db.batch([
		...lines.map((l) => db.prepare(
			`INSERT INTO edi_exceptions (edi_id, invoice_id, customer_id, po_number, po_line, sku, quantity, unit_price, problem, status, created)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'O', ?)`,
		).bind(inbound.id, inv.id, inv.customer_id, inv.po_number, l.po_line, l.sku, l.quantity, l.unit_price, l.problem, ts)),
		logStmt(db, "EDI", `CUS0540W ${inbound.id} PO ${inv.po_number} FROM ${inv.customer_id}: ${lines.length} LINE(S) HELD FOR CORRECTION ON ${inv.id}`.slice(0, 120)),
	]);
}

// listExceptions returns exceptions, oldest first: the open ones, or with
// all, every one.
export async function listExceptions(db: D1Database, all = false): Promise<EdiException[]> {
	const { results } = await db.prepare(
		`SELECT * FROM edi_exceptions WHERE ?1 OR status = 'O' ORDER BY ${all ? "seq DESC" : "seq"} LIMIT 500`,
	).bind(all ? 1 : 0).all<EdiException>();
	return results;
}

export async function openExceptions(db: D1Database, invoiceId: string): Promise<EdiException[]> {
	const { results } = await db.prepare("SELECT * FROM edi_exceptions WHERE invoice_id = ? AND status = 'O' ORDER BY seq")
		.bind(invoiceId).all<EdiException>();
	return results;
}

export async function getException(db: D1Database, seq: number): Promise<EdiException> {
	const row = await db.prepare("SELECT * FROM edi_exceptions WHERE seq = ?").bind(seq).first<EdiException>();
	if (!row) throw new HttpError(404, "not_found", `EDI exception ${seq} not found`);
	return row;
}

// claim moves an open exception to a new status, or explains why it is
// not open.
async function claim(db: D1Database, user: string, seq: number, status: EdiException["status"], sku = ""): Promise<EdiException> {
	const row = await db.prepare(
		`UPDATE edi_exceptions SET status = ?2, corrected_sku = ?3, resolved = ?4, resolved_by = ?5
		 WHERE seq = ?1 AND status = 'O' RETURNING *`,
	).bind(seq, status, sku, now(), user).first<EdiException>();
	if (row) return row;
	const x = await getException(db, seq);
	throw bad("sku", `exception ${seq} is already ${exceptionStatusNames[x.status].toLowerCase()}`);
}

// correctException puts the product an operator chose on the invoice for
// the quantity the customer ordered, at its current price.
export async function correctException(db: D1Database, user: string, seq: number, sku: string): Promise<{ exception: EdiException; line: InvoiceLine }> {
	sku = sku.trim().toUpperCase();
	if (!sku) throw bad("sku", "enter the SKU to put on the order");
	const x = await claim(db, user, seq, "C", sku);
	let line: InvoiceLine;
	try {
		line = await addLine(db, x.invoice_id, sku, x.quantity);
	} catch (e) {
		// Leave it for another try.
		await db.prepare("UPDATE edi_exceptions SET status = 'O', corrected_sku = '', resolved = '', resolved_by = '' WHERE seq = ?").bind(seq).run();
		throw e;
	}
	const [done] = await db.batch<EdiException>([
		db.prepare("UPDATE edi_exceptions SET line = ? WHERE seq = ? RETURNING *").bind(line.line, seq),
		logStmt(db, user, `CUS0541I ${x.invoice_id} PO1 LINE ${x.po_line} CORRECTED TO ${sku} BY ${user}`),
	]);
	return { exception: done.results[0], line };
}

// dropException leaves a held line off the order.
export async function dropException(db: D1Database, user: string, seq: number): Promise<EdiException> {
	const x = await claim(db, user, seq, "D");
	await logStmt(db, user, `CUS0542I ${x.invoice_id} PO1 LINE ${x.po_line} (${x.sku || "NO SKU"}) DROPPED BY ${user}`).run();
	return x;
}

// rejectOrder rejects the whole order an exception belongs to: its invoice
// is cancelled, returning the stock of the lines that were filled, its open
// exceptions are closed, and the 850 is marked rejected.
export async function rejectOrder(db: D1Database, user: string, seq: number): Promise<EdiException> {
	const x = await getException(db, seq);
	if (x.status !== "O") throw bad("sku", `exception ${seq} is already ${exceptionStatusNames[x.status].toLowerCase()}`);
	await cancelInvoice(db, x.invoice_id);
	const note = `ORDER REJECTED BY ${user}: PO1 LINE ${x.po_line} ${x.problem}`.slice(0, 120);
	await db.batch([
		db.prepare(
			"UPDATE edi_exceptions SET status = 'X', resolved = ?, resolved_by = ? WHERE invoice_id = ? AND status = 'O'",
		).bind(now(), user, x.invoice_id),
		db.prepare("UPDATE edi SET status = 'REJECTED', note = ? WHERE id = ?").bind(note, x.edi_id),
		logStmt(db, user, `CUS0543W ${x.edi_id} PO ${x.po_number} FROM ${x.customer_id} REJECTED BY ${user}, ${x.invoice_id} CANCELLED`),
	]);
	return getException(db, seq);
}
