// Customer data access, shared by the REST endpoints (index.ts) and the
// screens (screens/). Functions return records or throw HttpError.

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
	const [, inserted] = await db.batch<Customer>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'customer_id'"),
		db.prepare(
			`INSERT INTO customers (id, name, address, city, state, zip, phone, credit_limit, balance, status, version, updated, updated_by)
			 SELECT printf('%06d', value), ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ? FROM counters WHERE name = 'customer_id'
			 RETURNING *`,
		).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, now(), user),
	]);
	return inserted.results[0];
}

// updateCustomer applies an edit if the record is still at version; it
// throws 404 if the record is gone and 409 if someone else changed it.
export async function updateCustomer(
	db: D1Database, id: string, f: Editable, version: number, user: string,
): Promise<Customer> {
	const row = await db.prepare(
		`UPDATE customers
		 SET name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, credit_limit = ?, status = ?,
		     version = version + 1, updated = ?, updated_by = ?
		 WHERE id = ? AND version = ?
		 RETURNING *`,
	).bind(f.name, f.address, f.city, f.state, f.zip, f.phone, f.credit_limit, f.status, now(), user, id, version)
		.first<Customer>();
	if (row) return row;

	const exists = await db.prepare("SELECT 1 FROM customers WHERE id = ?").bind(id).first();
	if (!exists) throw notFound();
	throw new HttpError(409, "conflict", "record was changed by another user");
}

export async function deleteCustomer(db: D1Database, id: string): Promise<void> {
	const { meta } = await db.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
	if (meta.changes === 0) throw notFound();
}

export function notFound(): HttpError {
	return new HttpError(404, "not_found", "record not found");
}

function now(): string {
	return new Date().toISOString();
}
