// Customer data access, shared by the REST endpoints (index.ts) and the
// screens (screens/). Functions return records or throw HttpError. Every
// change also writes the change history (see activity.ts).

import { diff } from "./activity";
import { HttpError } from "./http";
import type { Customer, Editable } from "./customer";

export async function listCustomers(db: D1Database, prefix: string): Promise<Customer[]> {
	const like = prefix.toUpperCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const { results } = await db.prepare(
		"SELECT * FROM customers WHERE name LIKE ? ESCAPE '\\' ORDER BY name, id",
	).bind(like).all<Customer>();
	return results;
}

export async function getCustomer(db: D1Database, id: string): Promise<Customer> {
	const row = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
	if (!row) throw notFound();
	return row;
}

export async function createCustomer(db: D1Database, f: Editable, user: string): Promise<Customer> {
	// One batch is one transaction: take the next number and insert with it.
	const ts = now();
	const [, inserted] = await db.batch<Customer>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'customer_id'"),
		db.prepare(
			`INSERT INTO customers (id, name, address, city, state, zip, phone, credit_limit, balance, status, version, updated, updated_by)
			 SELECT printf('%06d', value), ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ? FROM counters WHERE name = 'customer_id'
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, ts, user),
		db.prepare(
			"INSERT INTO audit (customer_id, action, at, by) SELECT printf('%06d', value), 'ADD', ?, ? FROM counters WHERE name = 'customer_id'",
		).bind(ts, user),
	]);
	return inserted.results[0];
}

// updateCustomer applies an edit if the record is still at version; it
// throws 404 if the record is gone and 409 if someone else changed it.
export async function updateCustomer(
	db: D1Database, id: string, f: Editable, version: number, user: string,
): Promise<Customer> {
	const before = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
	if (!before) throw notFound();
	if (before.version !== version) throw conflict();

	// The history rows and the update share a condition and a batch, so they
	// land together or not at all. Versions only go up, so a record still at
	// the version read above still holds what was read.
	const ts = now();
	const audits = diff(before, f).map((d) =>
		db.prepare(
			`INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by)
			 SELECT ?, 'CHANGE', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND version = ?)`,
		).bind(id, d.field, d.from, d.to, ts, user, id, version),
	);
	const results = await db.batch<Customer>([
		...audits,
		db.prepare(
			`UPDATE customers
			 SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, credit_limit = ?, status = ?,
			     version = version + 1, updated = ?, updated_by = ?
			 WHERE id = ? AND version = ?
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, ts, user, id, version),
	]);
	const row = results[results.length - 1].results[0];
	if (row) return row;

	const exists = await db.prepare("SELECT 1 FROM customers WHERE id = ?").bind(id).first();
	if (!exists) throw notFound();
	throw conflict();
}

// deleteCustomer removes a customer and its transactions, keeping its
// change history with a DELETE row.
export async function deleteCustomer(db: D1Database, id: string, user: string): Promise<void> {
	const [, , deleted] = await db.batch([
		db.prepare(
			"INSERT INTO audit (customer_id, action, at, by) SELECT id, 'DELETE', ?, ? FROM customers WHERE id = ?",
		).bind(now(), user, id),
		db.prepare("DELETE FROM transactions WHERE customer_id = ?").bind(id),
		db.prepare("DELETE FROM customers WHERE id = ?").bind(id),
	]);
	if (deleted.meta.changes === 0) throw notFound();
}

export function notFound(): HttpError {
	return new HttpError(404, "not_found", "record not found");
}

function conflict(): HttpError {
	return new HttpError(409, "conflict", "record was changed by another user");
}

function now(): string {
	return new Date().toISOString();
}
