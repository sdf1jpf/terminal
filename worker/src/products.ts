// The product master file and stock on hand, shared by the REST endpoints
// (index.ts) and the screens (screens/products.ts). Validation errors name
// the terminal's input fields (e.g. "price", "onhand").

import { HttpError, int, str } from "./http";

export interface Product {
	sku: string;
	description: string;
	unit_price: number; // whole dollars
	on_hand: number;
	reorder_point: number;
	status: string; // A=active, D=discontinued
	vendor: string; // who supplies it, e.g. V00001; "" for none
	unit_cost: number; // what it costs us, whole dollars
	version: number;
	updated: string; // RFC 3339, UTC
	updated_by: string;
}

export const productFields = [
	"sku", "description", "unit_price", "on_hand", "reorder_point", "status", "vendor", "unit_cost",
	"version", "updated", "updated_by",
] as const;

export type ProductEdit = Pick<
	Product, "sku" | "description" | "unit_price" | "on_hand" | "reorder_point" | "status" | "vendor" | "unit_cost"
>;

const reSku = /^[A-Z0-9][A-Z0-9-]{0,9}$/;
const MAX = 9_999_999;

// parseProduct reads a product from a request body, normalizes it and
// applies the edit rules. It also returns the client's version.
export function parseProduct(body: Record<string, unknown>): { fields: ProductEdit; version: number } {
	const up = (k: string) => str(body, k).trim().toUpperCase();
	const fields: ProductEdit = {
		sku: up("sku"),
		description: up("description"),
		unit_price: int(body, "unit_price"),
		on_hand: int(body, "on_hand"),
		reorder_point: int(body, "reorder_point"),
		status: up("status"),
		vendor: up("vendor"),
		unit_cost: int(body, "unit_cost"),
	};
	str(body, "updated"), str(body, "updated_by");
	const version = int(body, "version");

	const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
	const f = fields;
	if (!reSku.test(f.sku)) throw bad("sku", "SKU must be 1 to 10 letters, digits or dashes");
	if (f.description === "") throw bad("desc", "description is required");
	if (f.description.length > 30) throw bad("desc", "description is limited to 30 characters");
	if (f.unit_price < 0 || f.unit_price > MAX) throw bad("price", "unit price must be a whole number of dollars");
	if (f.on_hand < 0 || f.on_hand > MAX) throw bad("onhand", "quantity on hand must be a whole, positive number");
	if (f.reorder_point < 0 || f.reorder_point > MAX) throw bad("reorder", "reorder point must be a whole, positive number");
	if (!["A", "D"].includes(f.status)) throw bad("status", "status must be A (active) or D (discontinued)");
	if (f.vendor !== "" && !/^V\d{5}$/.test(f.vendor)) throw bad("vendor", "vendor must be a vendor number such as V00001");
	if (f.unit_cost < 0 || f.unit_cost > MAX) throw bad("cost", "unit cost must be a whole number of dollars");
	return { fields, version };
}

// lowStock reports whether an active product is at or below its reorder
// point.
export function lowStock(p: Pick<Product, "on_hand" | "reorder_point" | "status">): boolean {
	return p.status === "A" && p.on_hand <= p.reorder_point;
}

export async function listProducts(db: D1Database, prefix: string): Promise<Product[]> {
	const like = prefix.toUpperCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const { results } = await db.prepare("SELECT * FROM products WHERE sku LIKE ? ESCAPE '\\' ORDER BY sku")
		.bind(like).all<Product>();
	return results;
}

// searchProducts finds the active products whose SKU or description
// contains text, for picking a product to sell. Blank text finds them all.
export async function searchProducts(db: D1Database, text: string): Promise<Product[]> {
	const like = "%" + text.trim().toUpperCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const { results } = await db.prepare(
		`SELECT * FROM products WHERE status = 'A' AND (sku LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\')
		 ORDER BY sku`,
	).bind(like).all<Product>();
	return results;
}

export async function getProduct(db: D1Database, sku: string): Promise<Product> {
	const row = await db.prepare("SELECT * FROM products WHERE sku = ?").bind(sku.toUpperCase()).first<Product>();
	if (!row) throw notFound();
	return row;
}

// checkVendor makes sure a product's vendor is on file.
async function checkVendor(db: D1Database, vendor: string): Promise<void> {
	if (vendor === "") return;
	const row = await db.prepare("SELECT 1 FROM vendors WHERE id = ?").bind(vendor).first();
	if (!row) throw new HttpError(422, "invalid", `vendor ${vendor} is not on file`, "vendor");
}

// adjustment records a change in a product's stock value at cost, for
// the ledger to journal. It runs after the statement that made the change,
// and only if that changed a row.
function adjustment(db: D1Database, sku: string, quantity: number, oldCost: number, newCost: number, amount: number, user: string) {
	return db.prepare(
		`INSERT INTO stock_adjustments (sku, quantity, old_cost, new_cost, amount, at, by)
		 SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 AND ?5 <> 0`,
	).bind(sku, quantity, oldCost, newCost, amount, new Date().toISOString(), user);
}

export async function createProduct(db: D1Database, f: ProductEdit, user: string): Promise<Product> {
	await checkVendor(db, f.vendor);
	const [inserted] = await db.batch<Product>([
		db.prepare(
			`INSERT INTO products (sku, description, unit_price, on_hand, reorder_point, status, vendor, unit_cost, version, updated, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (sku) DO NOTHING RETURNING *`,
		).bind(f.sku, f.description, f.unit_price, f.on_hand, f.reorder_point, f.status, f.vendor, f.unit_cost, new Date().toISOString(), user),
		adjustment(db, f.sku, f.on_hand, 0, f.unit_cost, f.on_hand * f.unit_cost, user),
	]);
	const row = inserted.results[0];
	if (!row) throw new HttpError(422, "invalid", `product ${f.sku} is already on file`, "sku");
	return row;
}

// updateProduct applies an edit if the product is still at version. The
// SKU is the key and cannot change. A change to the quantity on hand or the
// unit cost is recorded as a stock adjustment.
export async function updateProduct(db: D1Database, sku: string, f: ProductEdit, version: number, user: string): Promise<Product> {
	await checkVendor(db, f.vendor);
	const old = await getProduct(db, sku); // 404 if it is gone
	if (old.version !== version) throw new HttpError(409, "conflict", "record was changed by another user");
	const amount = f.on_hand * f.unit_cost - old.on_hand * old.unit_cost;
	const [updated] = await db.batch<Product>([
		db.prepare(
			`UPDATE products SET description = ?, unit_price = ?, on_hand = ?, reorder_point = ?, status = ?, vendor = ?, unit_cost = ?,
			     version = version + 1, updated = ?, updated_by = ?
			 WHERE sku = ? AND version = ? AND on_hand = ? AND unit_cost = ? RETURNING *`,
		).bind(f.description, f.unit_price, f.on_hand, f.reorder_point, f.status, f.vendor, f.unit_cost, new Date().toISOString(), user,
			old.sku, version, old.on_hand, old.unit_cost),
		adjustment(db, old.sku, f.on_hand - old.on_hand, old.unit_cost, f.unit_cost, amount, user),
	]);
	const row = updated.results[0];
	if (row) return row;
	throw new HttpError(409, "conflict", "record was changed by another user");
}

function notFound(): HttpError {
	return new HttpError(404, "not_found", "product not found");
}
