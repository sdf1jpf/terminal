// The management reports: sales by month, receivables aging and inventory
// turns. These read the subledgers as they stand; the screens that chart
// them are in screens/charts.ts, and the CUSAGING job prints the aging.

import type { Customer } from "./customer";

const DAY = 86_400_000;

export interface MonthSales {
	month: string; // YYYY-MM, UTC
	sales: number; // invoices posted to customers' accounts
	collected: number; // payments posted
	invoices: number;
}

// salesByMonth totals the invoices and payments posted in each of the last
// n months, oldest first, ending with the month of now.
export async function salesByMonth(db: D1Database, n: number, now = Date.now()): Promise<MonthSales[]> {
	const d = new Date(now);
	const months: MonthSales[] = [];
	for (let i = n - 1; i >= 0; i--) {
		const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
		months.push({ month: m.toISOString().slice(0, 7), sales: 0, collected: 0, invoices: 0 });
	}
	const { results } = await db.prepare(
		`SELECT substr(posted, 1, 7) AS month, type, SUM(amount) AS amount, COUNT(*) AS n
		 FROM transactions WHERE posted >= ? GROUP BY month, type`,
	).bind(months[0].month + "-01").all<{ month: string; type: string; amount: number; n: number }>();
	for (const r of results) {
		const m = months.find((m) => m.month === r.month);
		if (!m) continue;
		if (r.type === "I") {
			m.sales += r.amount;
			m.invoices += r.n;
		} else {
			m.collected += r.amount;
		}
	}
	return months;
}

export const AGING_BUCKETS = ["CURRENT", "31-60", "61-90", "OVER 90"] as const;

export interface AgedAccount extends Pick<Customer, "id" | "name" | "balance"> {
	buckets: number[]; // current, 31-60, 61-90 and over 90 days
}

// agedAccounts ages each balance by its unpaid invoices: payments are
// applied to the oldest invoices first, so the balance is made up of the
// newest invoices. Any balance older than the posted activity (such as an
// opening balance) counts as over 90 days.
export async function agedAccounts(db: D1Database, now = Date.now()): Promise<AgedAccount[]> {
	const [custs, invoices] = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT id, name, balance FROM customers WHERE balance > 0 ORDER BY id"),
		db.prepare("SELECT customer_id, amount, posted FROM transactions WHERE type = 'I' ORDER BY customer_id, seq DESC"),
	]);
	const byCust = new Map<string, { amount: number; posted: string }[]>();
	for (const inv of invoices.results as { customer_id: string; amount: number; posted: string }[]) {
		const list = byCust.get(inv.customer_id) ?? [];
		list.push(inv);
		byCust.set(inv.customer_id, list);
	}
	return (custs.results as Pick<Customer, "id" | "name" | "balance">[]).map((c) => {
		const buckets = [0, 0, 0, 0];
		let left = c.balance;
		for (const inv of byCust.get(c.id) ?? []) {
			if (left <= 0) break;
			const amt = Math.min(inv.amount, left);
			const days = (now - Date.parse(inv.posted)) / DAY;
			buckets[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3] += amt;
			left -= amt;
		}
		buckets[3] += left;
		return { ...c, buckets };
	});
}

export interface ProductTurns {
	sku: string;
	description: string;
	status: string;
	on_hand: number;
	reorder_point: number;
	unit_cost: number;
	value: number; // on hand at cost
	sold: number; // units billed in the period
	received: number; // units received from vendors in the period
	turns: number; // annualized: cost of sales over average inventory
	days: number; // days of supply at the period's rate of sale; Infinity if none sold
}

export interface Turns {
	days: number; // the period the rates are taken over
	value: number; // inventory at cost
	cogs: number; // annualized cost of sales
	turns: number;
	items: ProductTurns[];
}

// inventoryTurns works out how often each product's stock turns over in a
// year. The period is the last 365 days, or the days since the first sale
// or receipt in that time if that is shorter (but at least 30), and the
// rates are annualized from it. Opening stock is today's stock plus what
// was sold less what was received; average inventory is the mean of the
// opening and closing stock.
export async function inventoryTurns(db: D1Database, now = Date.now()): Promise<Turns> {
	const since = new Date(now - 365 * DAY).toISOString();
	const [prods, sold, recv] = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT sku, description, status, on_hand, reorder_point, unit_cost FROM products ORDER BY sku"),
		db.prepare(
			`SELECT l.sku, SUM(l.quantity) AS qty, MIN(i.billed) AS first FROM invoice_lines l
			 JOIN invoices i ON i.id = l.invoice_id
			 WHERE i.status IN ('B', 'P') AND i.billed >= ? GROUP BY l.sku`,
		).bind(since),
		db.prepare("SELECT sku, SUM(quantity) AS qty, MIN(at) AS first FROM receipts WHERE at >= ? GROUP BY sku").bind(since),
	]);
	type Sum = { sku: string; qty: number; first: string };
	const soldBy = new Map((sold.results as Sum[]).map((r) => [r.sku, r]));
	const recvBy = new Map((recv.results as Sum[]).map((r) => [r.sku, r]));
	const firsts = [...soldBy.values(), ...recvBy.values()].map((r) => Date.parse(r.first)).filter((t) => !isNaN(t));
	const first = firsts.length ? Math.min(...firsts) : now - 365 * DAY;
	const days = Math.min(Math.max(Math.ceil((now - first) / DAY), 30), 365);
	const year = 365 / days;

	let value = 0;
	let cogs = 0;
	let avgCost = 0;
	const items: ProductTurns[] = [];
	for (const p of prods.results as Pick<ProductTurns, "sku" | "description" | "status" | "on_hand" | "reorder_point" | "unit_cost">[]) {
		const out = soldBy.get(p.sku)?.qty ?? 0;
		const inn = recvBy.get(p.sku)?.qty ?? 0;
		if (p.status === "D" && p.on_hand === 0 && out === 0) continue;
		const avg = (p.on_hand + Math.max(p.on_hand + out - inn, 0)) / 2;
		const turns = out === 0 ? 0 : avg > 0 ? (out / avg) * year : 99.9;
		items.push({
			...p,
			value: p.on_hand * p.unit_cost,
			sold: out,
			received: inn,
			turns: Math.min(turns, 99.9),
			days: out > 0 ? Math.round(p.on_hand / (out / days)) : Infinity,
		});
		value += p.on_hand * p.unit_cost;
		cogs += out * p.unit_cost * year;
		avgCost += avg * p.unit_cost;
	}
	return {
		days,
		value,
		cogs: Math.round(cogs),
		turns: avgCost > 0 ? Math.min(cogs / avgCost, 99.9) : 0,
		items,
	};
}
