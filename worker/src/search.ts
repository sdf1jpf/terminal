// Global search: one query across customers, invoices, purchase orders,
// shipments, vendors and products, by name or number. It backs the
// CUSF01 SEARCH panel and GET /v1/search.

export type HitType = "C" | "I" | "O" | "S" | "V" | "P";

export const hitTypes: Record<HitType, string> = {
	C: "CUSTOMER",
	I: "INVOICE",
	O: "PURCHASE ORDER",
	S: "SHIPMENT",
	V: "VENDOR",
	P: "PRODUCT",
};

export interface Hit {
	type: HitType;
	key: string; // the record's ID: customer number, INV00001, SKU...
	description: string;
	status: string;
}

// Each type stops at this many hits, so a short query cannot list the world.
export const MAX_PER_TYPE = 50;

// search finds the records whose number or name contains text. A number
// also finds the customer with that number (105 is 000105) and the
// documents for that customer. Hits come grouped by type in the order of
// hitTypes. types limits the search to some of them.
export async function search(db: D1Database, text: string, types: HitType[] = []): Promise<Hit[]> {
	const q = text.trim().toUpperCase();
	if (q === "") return [];
	const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const cust = /^\d{1,6}$/.test(q) ? q.padStart(6, "0") : "";
	const want = (t: HitType) => types.length === 0 || types.includes(t);

	const queries: [HitType, D1PreparedStatement][] = [
		["C", db.prepare(
			`SELECT id AS key, name || ', ' || city || ' ' || state AS description, status FROM customers
			 WHERE id = ?2 OR name LIKE ?1 ESCAPE '\\' OR city LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\'
			 ORDER BY id = ?2 DESC, name, id LIMIT ${MAX_PER_TYPE}`,
		)],
		["I", db.prepare(
			`SELECT i.id AS key, i.customer_id || ' ' || coalesce(c.name, '(DELETED)') ||
			   CASE WHEN i.po_number = '' THEN '' ELSE ' PO ' || i.po_number END AS description,
			   i.status AS status FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
			 WHERE i.id LIKE ?1 ESCAPE '\\' OR i.po_number LIKE ?1 ESCAPE '\\' OR i.customer_id = ?2 OR c.name LIKE ?1 ESCAPE '\\'
			 ORDER BY i.id DESC LIMIT ${MAX_PER_TYPE}`,
		)],
		["O", db.prepare(
			`SELECT p.id AS key, p.vendor_id || ' ' || coalesce(v.name, '') AS description, p.status AS status
			 FROM purchase_orders p LEFT JOIN vendors v ON v.id = p.vendor_id
			 WHERE p.id LIKE ?1 ESCAPE '\\' OR p.vendor_id LIKE ?1 ESCAPE '\\' OR v.name LIKE ?1 ESCAPE '\\'
			 ORDER BY p.id DESC LIMIT ${MAX_PER_TYPE}`,
		)],
		["S", db.prepare(
			`SELECT s.id AS key, s.invoice_id || ' ' || coalesce(c.name, s.customer_id) ||
			   CASE WHEN s.tracking = '' THEN '' ELSE ' ' || s.tracking END AS description, s.status AS status
			 FROM shipments s LEFT JOIN customers c ON c.id = s.customer_id
			 WHERE s.id LIKE ?1 ESCAPE '\\' OR s.invoice_id LIKE ?1 ESCAPE '\\' OR s.tracking LIKE ?1 ESCAPE '\\'
			   OR s.customer_id = ?2 OR c.name LIKE ?1 ESCAPE '\\'
			 ORDER BY s.id DESC LIMIT ${MAX_PER_TYPE}`,
		)],
		["V", db.prepare(
			`SELECT id AS key, name || ', ' || city || ' ' || state AS description, status FROM vendors
			 WHERE id LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR city LIKE ?1 ESCAPE '\\'
			 ORDER BY id LIMIT ${MAX_PER_TYPE}`,
		)],
		["P", db.prepare(
			`SELECT sku AS key, description, status FROM products
			 WHERE sku LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\' OR vendor LIKE ?1 ESCAPE '\\'
			 ORDER BY sku LIMIT ${MAX_PER_TYPE}`,
		)],
	];
	const run = queries.filter(([t]) => want(t));
	if (run.length === 0) return [];
	// Only some of the statements look the number up as a customer (?2).
	const results = await db.batch<{ key: string; description: string; status: string }>(
		run.map(([t, stmt]) => ("CIS".includes(t) ? stmt.bind(like, cust) : stmt.bind(like))),
	);
	return run.flatMap(([type], i) =>
		results[i].results.map((r) => ({ type, key: r.key, description: r.description, status: r.status })),
	);
}

// Filter is a structured search, which ai.ts makes from plain English:
// one type of record, with conditions on its fields.
export interface Filter {
	type: HitType;
	text?: string; // in the name or description
	state?: string; // customers and vendors
	city?: string;
	status?: string;
	overLimit?: boolean; // customers: balance above the credit limit
	lowStock?: boolean; // products: at or below the reorder point
	min?: number; // dollars: customer balance, invoice or PO total, unit price
	max?: number;
	carrier?: string; // shipments
	days?: number; // created in the last so many days: invoices, POs, shipments
}

// filterSearch finds the records that meet a filter. also adds records by
// key whatever the text says: products ai.ts found by meaning.
export async function filterSearch(db: D1Database, f: Filter, also: string[] = []): Promise<Hit[]> {
	const where: string[] = [];
	const args: unknown[] = [];
	const cond = (sql: string, ...v: unknown[]) => {
		where.push(sql);
		args.push(...v);
	};
	const like = (s: string) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const since = f.days ? new Date(Date.now() - f.days * 86_400_000).toISOString() : "";
	let sql: string;
	let order: string;
	let text: string[]; // the columns the text is looked for in
	let key: string; // the key column, for also
	let status = "status";
	switch (f.type) {
		case "C":
			sql = `SELECT id AS key, name || ', ' || city || ' ' || state AS description, status FROM customers`;
			order = "name, id";
			text = ["name", "city", "phone"];
			key = "id";
			if (f.state) cond("state = ?", f.state);
			if (f.city) cond("city LIKE ? ESCAPE '\\'", like(f.city));
			if (f.overLimit) cond("balance > credit_limit");
			if (f.min !== undefined) cond("balance >= ?", f.min);
			if (f.max !== undefined) cond("balance <= ?", f.max);
			break;
		case "I":
			sql = `SELECT i.id AS key, i.customer_id || ' ' || coalesce(c.name, '(DELETED)') || ' $' || i.total AS description,
			   i.status AS status FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id`;
			order = "i.id DESC";
			text = ["c.name", "i.po_number"];
			key = "i.id";
			status = "i.status";
			if (f.min !== undefined) cond("i.total >= ?", f.min);
			if (f.max !== undefined) cond("i.total <= ?", f.max);
			if (since) cond("i.created >= ?", since);
			break;
		case "O":
			sql = `SELECT p.id AS key, p.vendor_id || ' ' || coalesce(v.name, '') || ' $' || p.total AS description, p.status AS status
			   FROM purchase_orders p LEFT JOIN vendors v ON v.id = p.vendor_id`;
			order = "p.id DESC";
			text = ["v.name"];
			key = "p.id";
			status = "p.status";
			if (f.min !== undefined) cond("p.total >= ?", f.min);
			if (f.max !== undefined) cond("p.total <= ?", f.max);
			if (since) cond("p.created >= ?", since);
			break;
		case "S":
			sql = `SELECT s.id AS key, s.invoice_id || ' ' || coalesce(c.name, s.customer_id) ||
			   CASE WHEN s.tracking = '' THEN '' ELSE ' ' || s.tracking END AS description, s.status AS status
			   FROM shipments s LEFT JOIN customers c ON c.id = s.customer_id`;
			order = "s.id DESC";
			text = ["c.name", "s.tracking"];
			key = "s.id";
			status = "s.status";
			if (f.carrier) cond("s.carrier = ?", f.carrier);
			if (since) cond("s.created >= ?", since);
			break;
		case "V":
			sql = `SELECT id AS key, name || ', ' || city || ' ' || state AS description, status FROM vendors`;
			order = "id";
			text = ["name", "city"];
			key = "id";
			if (f.state) cond("state = ?", f.state);
			if (f.city) cond("city LIKE ? ESCAPE '\\'", like(f.city));
			break;
		case "P":
			sql = `SELECT sku AS key, description, status FROM products`;
			order = "sku";
			text = ["sku", "description"];
			key = "sku";
			if (f.lowStock) cond("on_hand <= reorder_point");
			if (f.min !== undefined) cond("unit_price >= ?", f.min);
			if (f.max !== undefined) cond("unit_price <= ?", f.max);
			break;
	}
	if (f.status) cond(`${status} = ?`, f.status);
	// Every word of the text has to be there, in any of the text columns.
	// Products found by meaning count whatever the words say.
	const wordConds: string[] = [];
	const wordArgs: unknown[] = [];
	for (const w of (f.text ?? "").split(/\s+/).filter(Boolean)) {
		wordConds.push("(" + text.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
		wordArgs.push(...text.map(() => like(w)));
	}
	const byKey = also.length > 0 ? `${key} IN (${also.map(() => "?").join(", ")})` : "";
	if (wordConds.length > 0 && byKey) cond(`((${wordConds.join(" AND ")}) OR ${byKey})`, ...wordArgs, ...also);
	else if (wordConds.length > 0) cond(wordConds.join(" AND "), ...wordArgs);
	else if (byKey) cond(byKey, ...also);
	const q = `${sql}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ${MAX_PER_TYPE}`;
	const { results } = await db.prepare(q).bind(...args).all<{ key: string; description: string; status: string }>();
	return results.map((r) => ({ type: f.type, key: r.key, description: r.description, status: r.status }));
}
