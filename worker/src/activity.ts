// Account activity (invoices and payments) and the change history. The JSON
// field names match internal/customer/activity.go in the Go client.

import { HttpError, int, str } from "./http";
import type { Customer } from "./customer";

export interface Transaction {
	seq: number;
	customer_id: string;
	type: string; // I=invoice, P=payment
	amount: number; // whole dollars, always positive
	reference: string;
	balance: number; // customer balance after posting
	posted: string; // RFC 3339, UTC
	posted_by: string;
}

export interface Change {
	seq: number;
	customer_id: string;
	action: string; // ADD, CHANGE or DELETE
	field: string; // CHANGE only
	old_value: string;
	new_value: string;
	at: string; // RFC 3339, UTC
	by: string;
}

export const transactionFields = [
	"seq", "customer_id", "type", "amount", "reference", "balance", "posted", "posted_by",
] as const;

export interface Posting {
	type: string;
	amount: number;
	reference: string;
}

// parsePosting reads a posting from a request body and applies the edit
// rules. Errors name the terminal's input fields.
export function parsePosting(body: Record<string, unknown>): Posting {
	const type = str(body, "type").trim().toUpperCase();
	const amount = int(body, "amount");
	const reference = str(body, "reference").trim().toUpperCase();
	// The remaining keys are accepted but must be well-typed.
	str(body, "customer_id"), str(body, "posted"), str(body, "posted_by"), int(body, "seq"), int(body, "balance");

	const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
	if (type !== "I" && type !== "P") throw bad("type", "type must be I (invoice) or P (payment)");
	if (amount <= 0 || amount > 999_999_999) throw bad("amount", "amount must be a whole number of dollars above zero");
	if (reference.length > 12) throw bad("ref", "reference is limited to 12 characters");
	return { type, amount, reference };
}

// The fields the change history tracks, by the names the terminal shows.
const tracked: [string, keyof Customer][] = [
	["NAME", "name"], ["ADDRESS", "address"], ["CITY", "city"], ["STATE", "state"],
	["ZIP", "zip"], ["PHONE", "phone"], ["LIMIT", "credit_limit"], ["STATUS", "status"],
];

// diff lists the tracked fields that differ between two copies of a record.
export function diff(before: Customer, after: Partial<Customer>): { field: string; from: string; to: string }[] {
	const out = [];
	for (const [field, key] of tracked) {
		const from = String(before[key]);
		const to = String(after[key] ?? before[key]);
		if (from !== to) out.push({ field, from, to });
	}
	return out;
}

// listTransactions returns a customer's activity, newest first, or
// undefined if there is no such customer.
export async function listTransactions(db: D1Database, id: string): Promise<Transaction[] | undefined> {
	const exists = await db.prepare("SELECT 1 FROM customers WHERE id = ?").bind(id).first();
	if (!exists) return undefined;
	const { results } = await db.prepare(
		"SELECT * FROM transactions WHERE customer_id = ? ORDER BY seq DESC LIMIT 500",
	).bind(id).all<Transaction>();
	return results;
}

// postTransaction records an invoice or payment and moves the balance in
// one batch. Invoices need an active customer; payments are taken in any
// status.
export async function postTransaction(db: D1Database, user: string, id: string, p: Posting): Promise<Transaction> {
	const delta = p.type === "I" ? p.amount : -p.amount;
	const allowed = p.type === "I" ? "status = 'A'" : "1";
	const [, inserted] = await db.batch<Transaction>([
		db.prepare(`UPDATE customers SET balance = balance + ? WHERE id = ? AND ${allowed}`).bind(delta, id),
		db.prepare(
			`INSERT INTO transactions (customer_id, type, amount, reference, balance, posted, posted_by)
			 SELECT id, ?, ?, ?, balance, ?, ? FROM customers WHERE id = ? AND ${allowed}
			 RETURNING *`,
		).bind(p.type, p.amount, p.reference, new Date().toISOString(), user, id),
	]);
	const row = inserted.results[0];
	if (row) return row;

	const cust = await db.prepare("SELECT status FROM customers WHERE id = ?").bind(id).first<{ status: string }>();
	if (!cust) throw new HttpError(404, "not_found", "record not found");
	const why = cust.status === "H" ? "on hold" : "closed";
	throw new HttpError(422, "invalid", `customer is ${why} - invoices cannot be posted`, "type");
}

// customerHistory returns a customer's change history, newest first. It
// is empty, not an error, for a customer that never existed.
export async function customerHistory(db: D1Database, id: string): Promise<Change[]> {
	const { results } = await db.prepare(
		"SELECT * FROM audit WHERE customer_id = ? ORDER BY seq DESC LIMIT 500",
	).bind(id).all<Change>();
	return results;
}
