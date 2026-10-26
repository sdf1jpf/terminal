// Sales: salespeople, territories, customer pricing and sales by territory
// and salesperson. Shared by the REST endpoints (index.ts) and the screens
// (screens/sales.ts); the tables are in migration 0040.
//
// Every state belongs to a territory and every territory has a salesperson.
// A customer is in its state's territory unless assigned to another, and is
// served by that territory's salesperson unless assigned its own. Invoices
// record both when they are opened (invoices.ts createInvoice).
//
// A customer's pricing agreements are discounts off list or contract
// prices, for a SKU, a product line (the SKU's prefix, BRG for BRG-6204) or
// * for everything. The most specific agreement prices a line when it is
// added to an invoice, whether by hand or from an 850 (invoices.ts addLine).
//
// Percentages are kept in tenths, so 35 is 3.5%.

import { HttpError } from "./http";

export interface Salesperson {
	id: string;
	name: string;
	comm_pct10: number;
	status: "A" | "I";
	updated: string;
	updated_by: string;
}

export interface Territory {
	code: string;
	name: string;
	salesperson: string;
	updated: string;
	updated_by: string;
	states: string[];
}

export interface Pricing {
	customer_id: string;
	item: string; // a SKU, a product line or *
	disc_pct10: number;
	price: number; // a contract price, whole dollars; 0 for a discount
	updated: string;
	updated_by: string;
}

// Assignment is who sells to a customer, and whether it comes from the
// customer's state or was assigned to it.
export interface Assignment {
	territory: string;
	territory_name: string;
	territory_assigned: boolean;
	salesperson: string;
	salesperson_name: string;
	salesperson_assigned: boolean;
}

const bad = (field: string, message: string) => new HttpError(422, "invalid", message, field);
const now = () => new Date().toISOString();

// pct shows a percentage kept in tenths: 10%, 3.5%.
export const pct = (p10: number) => `${p10 % 10 === 0 ? p10 / 10 : (p10 / 10).toFixed(1)}%`;

// parsePct reads a percentage as typed, such as 10, 3.5 or 12.5%, into tenths.
export function parsePct(field: string, v: string, max: number): number {
	const s = v.trim().replace(/%$/, "");
	if (!/^\d{1,3}(\.\d)?$/.test(s)) throw bad(field, "percentage must be a number such as 10 or 3.5");
	const p10 = Math.round(Number(s) * 10);
	if (p10 > max) throw bad(field, `percentage is limited to ${pct(max)}`);
	return p10;
}

// productLine is the part of a SKU before its dash: BRG for BRG-6204.
export const productLine = (sku: string) => sku.split("-")[0];

// ---- salespeople ----

export async function listSalespeople(db: D1Database): Promise<Salesperson[]> {
	const { results } = await db.prepare("SELECT * FROM salespeople ORDER BY id").all<Salesperson>();
	return results;
}

// saveSalesperson adds a salesperson, or changes one when id is given. A
// salesperson who still has territories or customers cannot be made
// inactive.
export async function saveSalesperson(
	db: D1Database, user: string, id: string, f: { name: string; comm: string; status: string },
): Promise<Salesperson> {
	const name = f.name.trim().toUpperCase();
	if (name === "") throw bad("name", "salesperson name is required");
	if (name.length > 24) throw bad("name", "salesperson name is limited to 24 characters");
	const comm = parsePct("comm", f.comm || "0", 500);
	const status = (f.status.trim().toUpperCase() || "A") as Salesperson["status"];
	if (status !== "A" && status !== "I") throw bad("status", "status must be A (active) or I (inactive)");
	const ts = now();
	if (!id) {
		const [, row] = await db.batch<Salesperson>([
			db.prepare("INSERT OR IGNORE INTO counters (name, value) SELECT 'salesperson_id', COUNT(*) FROM salespeople"),
			db.prepare(
				`INSERT INTO salespeople (id, name, comm_pct10, status, updated, updated_by)
				 SELECT printf('S%02d', value + 1), ?1, ?2, ?3, ?4, ?5 FROM counters WHERE name = 'salesperson_id'
				 RETURNING *`,
			).bind(name, comm, status, ts, user),
			db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'salesperson_id'"),
		]);
		return row.results[0];
	}
	if (status === "I") {
		const used = await db.prepare(
			`SELECT (SELECT code FROM territories WHERE salesperson = ?1 LIMIT 1) AS territory,
			        (SELECT id FROM customers WHERE salesperson = ?1 LIMIT 1) AS customer`,
		).bind(id).first<{ territory: string | null; customer: string | null }>();
		if (used?.territory) throw bad("status", `${id} still covers territory ${used.territory} - reassign it first`);
		if (used?.customer) throw bad("status", `${id} is still assigned to customer ${used.customer} - reassign it first`);
	}
	const row = await db.prepare(
		"UPDATE salespeople SET name = ?2, comm_pct10 = ?3, status = ?4, updated = ?5, updated_by = ?6 WHERE id = ?1 RETURNING *",
	).bind(id, name, comm, status, ts, user).first<Salesperson>();
	if (!row) throw new HttpError(404, "not_found", `salesperson ${id} not found`);
	return row;
}

// activeSalesperson checks a salesperson ID typed for a territory or a
// customer: blank, or an active salesperson.
async function activeSalesperson(db: D1Database, field: string, id: string): Promise<string> {
	id = id.trim().toUpperCase();
	if (id === "") return "";
	const sp = await db.prepare("SELECT status FROM salespeople WHERE id = ?").bind(id).first<{ status: string }>();
	if (!sp) throw bad(field, `salesperson ${id} is not on file`);
	if (sp.status !== "A") throw bad(field, `salesperson ${id} is inactive`);
	return id;
}

// ---- territories ----

export async function listTerritories(db: D1Database): Promise<Territory[]> {
	const [terrs, states] = await db.batch<any>([
		db.prepare("SELECT * FROM territories ORDER BY code"),
		db.prepare("SELECT state, territory FROM territory_states ORDER BY state"),
	]);
	return (terrs.results as Omit<Territory, "states">[]).map((t) => ({
		...t,
		states: (states.results as { state: string; territory: string }[]).filter((s) => s.territory === t.code).map((s) => s.state),
	}));
}

const reState = /^[A-Z]{2}$/;
const reCode = /^[A-Z0-9]{1,4}$/;

// saveTerritory adds or changes a territory. The states listed move to it
// from whichever territory had them; a state left off goes nowhere, so its
// customers are house accounts until it is given to a territory again.
export async function saveTerritory(
	db: D1Database, user: string, f: { code: string; name: string; salesperson: string; states: string },
): Promise<Territory> {
	const code = f.code.trim().toUpperCase();
	if (!reCode.test(code)) throw bad("code", "territory code is 1 to 4 letters or digits");
	const name = f.name.trim().toUpperCase();
	if (name === "") throw bad("tname", "territory name is required");
	if (name.length > 20) throw bad("tname", "territory name is limited to 20 characters");
	const rep = await activeSalesperson(db, "trep", f.salesperson);
	const states = [...new Set(f.states.toUpperCase().split(/[\s,]+/).filter(Boolean))].sort();
	const wrong = states.find((s) => !reState.test(s));
	if (wrong) throw bad("states", `${wrong} is not a two letter state code`);
	const ts = now();
	await db.batch([
		db.prepare(
			`INSERT INTO territories (code, name, salesperson, updated, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT (code) DO UPDATE SET name = ?2, salesperson = ?3, updated = ?4, updated_by = ?5`,
		).bind(code, name, rep, ts, user),
		db.prepare(`DELETE FROM territory_states WHERE territory = ?1 AND state NOT IN (SELECT value FROM json_each(?2))`)
			.bind(code, JSON.stringify(states)),
		db.prepare(
			`INSERT INTO territory_states (state, territory) SELECT value, ?1 FROM json_each(?2) WHERE true
			 ON CONFLICT (state) DO UPDATE SET territory = ?1`,
		).bind(code, JSON.stringify(states)),
	]);
	return (await listTerritories(db)).find((t) => t.code === code)!;
}

// deleteTerritory removes a territory with no states and no customers
// assigned to it.
export async function deleteTerritory(db: D1Database, code: string): Promise<void> {
	const used = await db.prepare(
		`SELECT (SELECT state FROM territory_states WHERE territory = ?1 LIMIT 1) AS state,
		        (SELECT id FROM customers WHERE territory = ?1 LIMIT 1) AS customer`,
	).bind(code).first<{ state: string | null; customer: string | null }>();
	if (used?.state) throw bad("states", `territory ${code} still has states - move them first`);
	if (used?.customer) throw bad("code", `customer ${used.customer} is still assigned to territory ${code}`);
	const { meta } = await db.prepare("DELETE FROM territories WHERE code = ?").bind(code).run();
	if (meta.changes === 0) throw new HttpError(404, "not_found", `territory ${code} not found`);
}

// ---- who sells to a customer ----

// The territory and salesperson of the customer ?1, as an SQL expression,
// so an invoice can take them in the statement that opens it.
export const territoryOf = `COALESCE(NULLIF((SELECT territory FROM customers WHERE id = ?1), ''),
	(SELECT t.territory FROM customers c JOIN territory_states t ON t.state = c.state WHERE c.id = ?1), '')`;
export const salespersonOf = `COALESCE(NULLIF((SELECT salesperson FROM customers WHERE id = ?1), ''),
	(SELECT salesperson FROM territories WHERE code = ${territoryOf}), '')`;

export async function assignment(db: D1Database, customerId: string): Promise<Assignment> {
	const row = await db.prepare(
		`SELECT ${territoryOf} AS territory, ${salespersonOf} AS salesperson, c.territory <> '' AS territory_assigned,
		        c.salesperson <> '' AS salesperson_assigned
		 FROM customers c WHERE c.id = ?1`,
	).bind(customerId).first<{ territory: string; salesperson: string; territory_assigned: number; salesperson_assigned: number }>();
	if (!row) throw new HttpError(404, "not_found", "record not found");
	const names = await db.prepare(
		"SELECT (SELECT name FROM territories WHERE code = ?1) AS t, (SELECT name FROM salespeople WHERE id = ?2) AS s",
	).bind(row.territory, row.salesperson).first<{ t: string | null; s: string | null }>();
	return {
		territory: row.territory,
		territory_name: names?.t ?? "",
		territory_assigned: !!row.territory_assigned,
		salesperson: row.salesperson,
		salesperson_name: names?.s ?? (row.salesperson ? "" : "HOUSE ACCOUNT"),
		salesperson_assigned: !!row.salesperson_assigned,
	};
}

// assign gives a customer its own territory or salesperson, or with blanks
// puts it back on its state's territory and that territory's salesperson.
// The change goes on the customer's event history.
export async function assign(
	db: D1Database, user: string, customerId: string, f: { territory: string; salesperson: string },
): Promise<Assignment> {
	const territory = f.territory.trim().toUpperCase();
	if (territory) {
		const t = await db.prepare("SELECT 1 FROM territories WHERE code = ?").bind(territory).first();
		if (!t) throw bad("terr", `territory ${territory} is not on file`);
	}
	const rep = await activeSalesperson(db, "rep", f.salesperson);
	const before = await db.prepare("SELECT territory, salesperson FROM customers WHERE id = ?").bind(customerId)
		.first<{ territory: string; salesperson: string }>();
	if (!before) throw new HttpError(404, "not_found", "record not found");
	const ts = now();
	const audit = (field: string, from: string, to: string) => db.prepare(
		"INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by) VALUES (?, 'CHANGE', ?, ?, ?, ?, ?)",
	).bind(customerId, field, from, to, ts, user);
	const stmts = [
		db.prepare("UPDATE customers SET territory = ?2, salesperson = ?3, updated = ?4, updated_by = ?5 WHERE id = ?1")
			.bind(customerId, territory, rep, ts, user),
	];
	if (before.territory !== territory) stmts.push(audit("TERRITORY", before.territory, territory));
	if (before.salesperson !== rep) stmts.push(audit("SALESREP", before.salesperson, rep));
	if (stmts.length > 1) await db.batch(stmts);
	return assignment(db, customerId);
}

// customerCounts counts the customers in each territory and served by
// each salesperson, as assigned or by their state.
export async function customerCounts(db: D1Database): Promise<{ territory: Map<string, number>; salesperson: Map<string, number> }> {
	const { results } = await db.prepare(
		`SELECT COALESCE(NULLIF(c.territory, ''), t.territory, '') AS terr,
		        COALESCE(NULLIF(c.salesperson, ''), r.salesperson, '') AS rep, COUNT(*) AS n
		 FROM customers c LEFT JOIN territory_states t ON t.state = c.state
		 LEFT JOIN territories r ON r.code = COALESCE(NULLIF(c.territory, ''), t.territory)
		 GROUP BY terr, rep`,
	).all<{ terr: string; rep: string; n: number }>();
	const territory = new Map<string, number>();
	const salesperson = new Map<string, number>();
	for (const r of results) {
		territory.set(r.terr, (territory.get(r.terr) ?? 0) + r.n);
		salesperson.set(r.rep, (salesperson.get(r.rep) ?? 0) + r.n);
	}
	return { territory, salesperson };
}

// setTaxExempt records a customer's sales tax exemption certificate, or
// with a blank makes it taxable again. Invoices billed from then on are
// taxed accordingly (invoices.ts billInvoice).
export async function setTaxExempt(db: D1Database, user: string, customerId: string, cert: string): Promise<string> {
	cert = cert.trim().toUpperCase();
	if (cert.length > 15) throw bad("exempt", "the exemption certificate number is limited to 15 characters");
	if (cert && !/^[A-Z0-9-]+$/.test(cert)) throw bad("exempt", "the certificate number is letters, digits and dashes");
	const before = await db.prepare("SELECT tax_exempt FROM customers WHERE id = ?").bind(customerId).first<{ tax_exempt: string }>();
	if (!before) throw new HttpError(404, "not_found", "record not found");
	if (before.tax_exempt === cert) return cert;
	const ts = now();
	await db.batch([
		db.prepare("UPDATE customers SET tax_exempt = ?2, updated = ?3, updated_by = ?4 WHERE id = ?1").bind(customerId, cert, ts, user),
		db.prepare(
			"INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by) VALUES (?, 'CHANGE', 'TAX EXEMPT', ?, ?, ?, ?)",
		).bind(customerId, before.tax_exempt, cert, ts, user),
	]);
	return cert;
}

// setEarlyPay offers a customer a discount for paying early, as typed
// on the pricing screen: 2/10 is 2% off if paid within 10 days of billing,
// and a blank takes the offer away. Invoices billed from then on carry it.
export async function setEarlyPay(db: D1Database, user: string, customerId: string, terms: string): Promise<{ pct10: number; days: number }> {
	const t = terms.trim().replace(/%/g, "");
	let pct10 = 0;
	let days = 0;
	if (t) {
		const m = /^(\d{1,2}(?:\.\d)?)\/(\d{1,2})$/.exec(t);
		if (!m) throw bad("early", "early-payment terms are percent/days, such as 2/10");
		pct10 = parsePct("early", m[1], 100);
		days = Number(m[2]);
		if (pct10 === 0 || days < 1 || days > 29) throw bad("early", "the discount must be over 0%, for paying within 1 to 29 days");
	}
	const before = await db.prepare("SELECT early_pct10, early_days FROM customers WHERE id = ?").bind(customerId)
		.first<{ early_pct10: number; early_days: number }>();
	if (!before) throw new HttpError(404, "not_found", "record not found");
	if (before.early_pct10 === pct10 && before.early_days === days) return { pct10, days };
	const show = (p: number, d: number) => (p ? `${pct(p).replace("%", "")}/${d}` : "");
	const ts = now();
	await db.batch([
		db.prepare("UPDATE customers SET early_pct10 = ?2, early_days = ?3, updated = ?4, updated_by = ?5 WHERE id = ?1")
			.bind(customerId, pct10, days, ts, user),
		db.prepare(
			"INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by) VALUES (?, 'CHANGE', 'EARLY PAY', ?, ?, ?, ?)",
		).bind(customerId, show(before.early_pct10, before.early_days), show(pct10, days), ts, user),
	]);
	return { pct10, days };
}

// ---- pricing ----

export async function listPricing(db: D1Database, customerId: string): Promise<Pricing[]> {
	const { results } = await db.prepare(
		// * first, then product lines, then SKUs
		"SELECT * FROM customer_pricing WHERE customer_id = ? ORDER BY item <> '*', instr(item, '-') > 0, item",
	).bind(customerId).all<Pricing>();
	return results;
}

// checkItem normalizes what an agreement, break or promotion is for: a SKU
// or product line on file, or *.
async function checkItem(db: D1Database, v: string): Promise<string> {
	const item = v.trim().toUpperCase();
	if (item === "") throw bad("item", "enter a SKU, a product line such as BRG, or * for everything");
	const known = item === "*" || await db.prepare(
		"SELECT 1 FROM products WHERE sku = ?1 OR substr(sku, 1, instr(sku || '-', '-') - 1) = ?1 LIMIT 1",
	).bind(item).first();
	if (!known) throw bad("item", `${item} is not a SKU or product line on file`);
	return item;
}

// setPricing adds or changes one of a customer's pricing agreements: a
// discount off list (disc) or a contract price (price), one or the other.
export async function setPricing(
	db: D1Database, user: string, customerId: string, f: { item: string; disc: string; price: string },
): Promise<Pricing> {
	const item = await checkItem(db, f.item);
	const disc = f.disc.trim();
	const price = f.price.trim().replace(/^\$/, "").replace(/,/g, "");
	if ((disc === "") === (price === "")) throw bad("disc", "enter either a discount percentage or a contract price");
	let d = 0;
	let p = 0;
	if (disc) {
		d = parsePct("disc", disc, 900);
		if (d === 0) throw bad("disc", "the discount must be more than 0%");
	} else {
		if (item === "*" || !item.includes("-")) throw bad("price", "a contract price is for one SKU - use a discount for a product line");
		if (!/^\d{1,9}$/.test(price) || Number(price) === 0) throw bad("price", "contract price must be a whole number of dollars above zero");
		p = Number(price);
	}
	const cust = await db.prepare("SELECT 1 FROM customers WHERE id = ?").bind(customerId).first();
	if (!cust) throw new HttpError(404, "not_found", "record not found");
	const old = await db.prepare("SELECT * FROM customer_pricing WHERE customer_id = ? AND item = ?").bind(customerId, item).first<Pricing>();
	const ts = now();
	const [row] = await db.batch<Pricing>([
		db.prepare(
			`INSERT INTO customer_pricing (customer_id, item, disc_pct10, price, updated, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT (customer_id, item) DO UPDATE SET disc_pct10 = ?3, price = ?4, updated = ?5, updated_by = ?6
			 RETURNING *`,
		).bind(customerId, item, d, p, ts, user),
		db.prepare(
			"INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by) VALUES (?, 'CHANGE', ?, ?, ?, ?, ?)",
		).bind(customerId, `PRICE ${item}`, old ? terms(old) : "", terms({ disc_pct10: d, price: p }), ts, user),
	]);
	return row.results[0];
}

export async function deletePricing(db: D1Database, user: string, customerId: string, item: string): Promise<void> {
	const old = await db.prepare("SELECT * FROM customer_pricing WHERE customer_id = ? AND item = ?").bind(customerId, item).first<Pricing>();
	if (!old) throw new HttpError(404, "not_found", `no pricing for ${item}`);
	await db.batch([
		db.prepare("DELETE FROM customer_pricing WHERE customer_id = ? AND item = ?").bind(customerId, item),
		db.prepare(
			"INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by) VALUES (?, 'CHANGE', ?, ?, '', ?, ?)",
		).bind(customerId, `PRICE ${item}`, terms(old), now(), user),
	]);
}

// terms describes an agreement: 10% OFF, or $42 CONTRACT.
export const terms = (p: Pick<Pricing, "disc_pct10" | "price">) => (p.price > 0 ? `$${p.price.toLocaleString("en-US")} CONTRACT` : `${pct(p.disc_pct10)} OFF`);

// The rule that prices a line, as recorded on it.
export interface LinePricing {
	disc_pct10: number;
	price: number; // a contract price, or 0
	rule: string; // e.g. BRG 10%, CONTRACT; "" at list
}

// pricingFor finds the agreement that prices a SKU for a customer: one for
// the SKU, else its product line, else *.
export async function pricingFor(db: D1Database, customerId: string, sku: string): Promise<LinePricing> {
	const line = productLine(sku);
	const { results } = await db.prepare(
		"SELECT * FROM customer_pricing WHERE customer_id = ?1 AND item IN (?2, ?3, '*')",
	).bind(customerId, sku, line).all<Pricing>();
	const best = results.find((r) => r.item === sku) ?? results.find((r) => r.item === line) ?? results.find((r) => r.item === "*");
	if (!best) return { disc_pct10: 0, price: 0, rule: "" };
	if (best.price > 0) return { disc_pct10: 0, price: best.price, rule: "CONTRACT" };
	return { disc_pct10: best.disc_pct10, price: 0, rule: `${best.item === "*" ? "ALL" : best.item} ${pct(best.disc_pct10)}`.slice(0, 20) };
}

// netPrice is what a customer pays for one unit at list under an
// agreement, rounded to the dollar.
export const netPrice = (list: number, p: Pick<LinePricing, "disc_pct10" | "price">) =>
	p.price > 0 ? p.price : Math.floor((list * (1000 - p.disc_pct10) + 500) / 1000);

// ---- quantity breaks and promotions ----

export interface QtyBreak {
	item: string;
	min_qty: number;
	disc_pct10: number; // taken off after the customer's price
	updated: string;
	updated_by: string;
}

export interface Promotion {
	id: string;
	description: string;
	item: string;
	disc_pct10: number;
	price: number; // a promotional price for a SKU, or 0
	starts: string; // YYYY-MM-DD
	ends: string;
	updated: string;
	updated_by: string;
}

// mostSpecific picks the row for a SKU, else its product line, else *.
function mostSpecific<T extends { item: string }>(rows: T[], sku: string): T[] {
	for (const key of [sku, productLine(sku), "*"]) {
		const hit = rows.filter((r) => r.item === key);
		if (hit.length) return hit;
	}
	return [];
}

export async function listBreaks(db: D1Database): Promise<QtyBreak[]> {
	const { results } = await db.prepare(
		"SELECT * FROM qty_breaks ORDER BY item <> '*', instr(item, '-') > 0, item, min_qty",
	).all<QtyBreak>();
	return results;
}

export async function setBreak(db: D1Database, user: string, f: { item: string; qty: string; disc: string }): Promise<QtyBreak> {
	const item = await checkItem(db, f.item);
	const qty = f.qty.trim();
	if (!/^\d{1,5}$/.test(qty) || Number(qty) < 2) throw bad("qty", "the break quantity must be a whole number from 2 to 99999");
	const d = parsePct("disc", f.disc || "0", 500);
	if (d === 0) throw bad("disc", "the break discount must be more than 0%");
	return (await db.prepare(
		`INSERT INTO qty_breaks (item, min_qty, disc_pct10, updated, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT (item, min_qty) DO UPDATE SET disc_pct10 = ?3, updated = ?4, updated_by = ?5 RETURNING *`,
	).bind(item, Number(qty), d, now(), user).first<QtyBreak>())!;
}

export async function deleteBreak(db: D1Database, item: string, minQty: number): Promise<void> {
	const { meta } = await db.prepare("DELETE FROM qty_breaks WHERE item = ? AND min_qty = ?").bind(item, minQty).run();
	if (meta.changes === 0) throw new HttpError(404, "not_found", `no quantity break for ${item} at ${minQty}`);
}

// breakFor is the quantity break a line of qty of sku earns, if any.
export async function breakFor(db: D1Database, sku: string, qty: number): Promise<QtyBreak | undefined> {
	// The most specific item with breaks has the say, even when the line
	// earns none of them.
	const { results } = await db.prepare("SELECT * FROM qty_breaks WHERE item IN (?1, ?2, '*')")
		.bind(sku, productLine(sku)).all<QtyBreak>();
	return mostSpecific(results, sku).filter((b) => b.min_qty <= qty).sort((a, b) => b.min_qty - a.min_qty)[0];
}

export async function listPromotions(db: D1Database): Promise<Promotion[]> {
	const { results } = await db.prepare("SELECT * FROM promotions ORDER BY starts DESC, id DESC").all<Promotion>();
	return results;
}

const reDay = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const today = () => new Date().toISOString().slice(0, 10);

// savePromotion adds a promotion, or changes one when id is given.
export async function savePromotion(
	db: D1Database, user: string, id: string,
	f: { description: string; item: string; disc: string; price: string; starts: string; ends: string },
): Promise<Promotion> {
	const description = f.description.trim().toUpperCase();
	if (description === "") throw bad("desc", "describe the promotion");
	if (description.length > 30) throw bad("desc", "the description is limited to 30 characters");
	const item = await checkItem(db, f.item);
	const disc = f.disc.trim();
	const price = f.price.trim().replace(/^\$/, "").replace(/,/g, "");
	if ((disc === "") === (price === "")) throw bad("disc", "enter either a discount percentage or a promotional price");
	let d = 0;
	let p = 0;
	if (disc) {
		d = parsePct("disc", disc, 900);
		if (d === 0) throw bad("disc", "the discount must be more than 0%");
	} else {
		if (!item.includes("-")) throw bad("price", "a promotional price is for one SKU - use a discount for a product line");
		if (!/^\d{1,9}$/.test(price) || Number(price) === 0) throw bad("price", "the price must be a whole number of dollars above zero");
		p = Number(price);
	}
	const starts = f.starts.trim() || today();
	const ends = f.ends.trim();
	if (!reDay.test(starts)) throw bad("starts", "dates are YYYY-MM-DD");
	if (!reDay.test(ends)) throw bad("ends", "dates are YYYY-MM-DD");
	if (ends < starts) throw bad("ends", "the promotion must end on or after the day it starts");
	const ts = now();
	if (!id) {
		const [, row] = await db.batch<Promotion>([
			db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'promotion_id'"),
			db.prepare(
				`INSERT INTO promotions (id, description, item, disc_pct10, price, starts, ends, updated, updated_by)
				 SELECT printf('PR%03d', value), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM counters WHERE name = 'promotion_id'
				 RETURNING *`,
			).bind(description, item, d, p, starts, ends, ts, user),
		]);
		return row.results[0];
	}
	const row = await db.prepare(
		`UPDATE promotions SET description = ?2, item = ?3, disc_pct10 = ?4, price = ?5, starts = ?6, ends = ?7, updated = ?8, updated_by = ?9
		 WHERE id = ?1 RETURNING *`,
	).bind(id, description, item, d, p, starts, ends, ts, user).first<Promotion>();
	if (!row) throw new HttpError(404, "not_found", `promotion ${id} not found`);
	return row;
}

export async function deletePromotion(db: D1Database, id: string): Promise<void> {
	const { meta } = await db.prepare("DELETE FROM promotions WHERE id = ?").bind(id).run();
	if (meta.changes === 0) throw new HttpError(404, "not_found", `promotion ${id} not found`);
}

// promotionFor is the promotion running on day for sku, if any; of two for
// the same item, the one that gives the lower price.
export async function promotionFor(db: D1Database, sku: string, list: number, day = today()): Promise<Promotion | undefined> {
	const { results } = await db.prepare(
		"SELECT * FROM promotions WHERE item IN (?1, ?2, '*') AND starts <= ?3 AND ends >= ?3",
	).bind(sku, productLine(sku), day).all<Promotion>();
	return mostSpecific(results, sku).sort((a, b) => netPrice(list, a) - netPrice(list, b))[0];
}

// The price of a line, as charged and recorded on it.
export interface LinePrice {
	unit_price: number;
	disc_pct10: number; // the discount off list it comes to, in tenths
	rule: string; // e.g. BRG 10% +QTY 5%; "" at list
}

// priceLine prices qty of sku at list for a customer on day: the lower of
// the customer's own price (pricingFor) and any promotion, then less the
// quantity break the line earns.
export async function priceLine(db: D1Database, customerId: string, sku: string, qty: number, list: number, day = today()): Promise<LinePrice> {
	const own = await pricingFor(db, customerId, sku);
	let unit = netPrice(list, own);
	let rule = own.rule;
	const promo = await promotionFor(db, sku, list, day);
	if (promo && netPrice(list, promo) < unit) {
		unit = netPrice(list, promo);
		rule = `PROMO ${promo.id}`;
	}
	const brk = await breakFor(db, sku, qty);
	if (brk) {
		unit = netPrice(unit, { disc_pct10: brk.disc_pct10, price: 0 });
		rule = `${rule ? rule + " +" : ""}QTY ${pct(brk.disc_pct10)}`;
	}
	const disc = list > 0 ? Math.max(Math.round(((list - unit) * 1000) / list), 0) : 0;
	return { unit_price: unit, disc_pct10: disc, rule: rule.slice(0, 24) };
}

// ---- sales by territory and salesperson ----

export interface SalesRow {
	key: string; // territory code or salesperson ID; "" for house accounts
	name: string;
	invoices: number;
	list: number; // what the lines come to at list
	discount: number; // list less what was charged
	net: number; // what was charged
	comm_pct10: number; // salesperson rows only
	commission: number;
}

// salesBy totals the invoices billed in a month (YYYY-MM, UTC) by the
// territory or the salesperson recorded on them. Net sales leave out sales
// tax. Commission is the salesperson's rate on net sales.
export async function salesBy(db: D1Database, by: "T" | "S", month: string): Promise<SalesRow[]> {
	const col = by === "T" ? "territory" : "salesperson";
	const { results } = await db.prepare(
		`SELECT i.${col} AS key, COUNT(*) AS invoices, SUM(i.subtotal) AS net,
		        SUM((SELECT COALESCE(SUM(l.quantity * l.list_price), 0) FROM invoice_lines l WHERE l.invoice_id = i.id)) AS list
		 FROM invoices i WHERE i.status IN ('B', 'P') AND substr(i.billed, 1, 7) = ?1
		 GROUP BY i.${col} ORDER BY i.${col}`,
	).bind(month).all<{ key: string; invoices: number; net: number; list: number }>();
	const names = new Map<string, { name: string; comm: number }>();
	if (by === "T") {
		for (const t of await listTerritories(db)) names.set(t.code, { name: t.name, comm: 0 });
	} else {
		for (const s of await listSalespeople(db)) names.set(s.id, { name: s.name, comm: s.comm_pct10 });
	}
	// Every territory or active salesperson gets a row, sales or not.
	const rows = new Map<string, SalesRow>();
	const row = (key: string): SalesRow => {
		let r = rows.get(key);
		if (!r) {
			const n = names.get(key);
			r = { key, name: n?.name ?? (key ? "(NOT ON FILE)" : "HOUSE ACCOUNTS"), invoices: 0, list: 0, discount: 0, net: 0, comm_pct10: n?.comm ?? 0, commission: 0 };
			rows.set(key, r);
		}
		return r;
	};
	for (const [key] of names) row(key);
	for (const r of results) {
		const x = row(r.key);
		x.invoices = r.invoices;
		x.net = r.net;
		x.list = Math.max(r.list, r.net);
		x.discount = x.list - r.net;
		x.commission = Math.round((r.net * x.comm_pct10) / 1000);
	}
	return [...rows.values()].sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.key.localeCompare(b.key)));
}
