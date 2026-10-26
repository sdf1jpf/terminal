import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agedAccounts, inventoryTurns, salesByMonth } from "../src/reports";
import { compact, niceMax } from "../src/screens/charts";

const DAY = 86_400_000;

describe("reports", () => {
	it("formats chart figures compactly", () => {
		expect(["$0", "$950", "$9.9K", "$10K", "$124K", "$1.0M", "$2.5M", "$12M"]).toEqual(
			[0, 950, 9_940, 9_950, 124_400, 999_600, 2_480_000, 12_000_000].map(compact),
		);
		expect([niceMax(0), niceMax(124), niceMax(1900), niceMax(2100), niceMax(30_000)]).toEqual([1000, 200, 2000, 2500, 50_000]);
	});

	it("totals sales and collections by month", async () => {
		const now = Date.parse("2026-10-15T12:00:00Z");
		const ins = (type: string, amount: number, at: string) =>
			env.DB.prepare("INSERT INTO transactions (customer_id, type, amount, balance, posted, posted_by) VALUES ('000101', ?, ?, 0, ?, 'T')")
				.bind(type, amount, at).run();
		await ins("I", 500, "2026-10-01T00:00:00Z");
		await ins("I", 250, "2026-10-14T00:00:00Z");
		await ins("P", 100, "2026-09-30T23:59:59Z");
		await ins("I", 900, "2025-10-31T00:00:00Z"); // 13 months back: not shown
		const months = await salesByMonth(env.DB, 12, now);
		expect(months.map((m) => m.month)).toEqual([
			"2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
			"2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
		]);
		expect(months.at(-1)).toMatchObject({ sales: 750, invoices: 2, collected: 0 });
		expect(months.at(-2)).toMatchObject({ sales: 0, collected: 100 });
		expect(months[0].sales).toBe(0);
	});

	it("ages a balance by its newest invoices", async () => {
		const now = Date.now();
		await env.DB.prepare("UPDATE customers SET balance = 0").run();
		await env.DB.prepare("UPDATE customers SET balance = 1000 WHERE id = '000101'").run();
		const ins = (amount: number, days: number) =>
			env.DB.prepare("INSERT INTO transactions (customer_id, type, amount, balance, posted, posted_by) VALUES ('000101', 'I', ?, 0, ?, 'T')")
				.bind(amount, new Date(now - days * DAY).toISOString()).run();
		await ins(300, 75);
		await ins(400, 45);
		await ins(200, 5);
		const [a, ...rest] = await agedAccounts(env.DB, now);
		expect(rest).toHaveLength(0);
		// $200 current, $400 at 45 days, $300 at 75 days and $100 older than any invoice.
		expect(a).toMatchObject({ id: "000101", balance: 1000, buckets: [200, 400, 300, 100] });
	});

	it("annualizes turns from the period's sales and receipts", async () => {
		const now = Date.now();
		await env.DB.prepare("UPDATE products SET on_hand = 10, unit_cost = 5 WHERE sku = 'BRG-6310'").run();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO invoices (id, customer_id, status, total, created, created_by, billed) VALUES ('INV09999', '000101', 'B', 0, ?, 'T', ?)",
			).bind(new Date(now - 60 * DAY).toISOString(), new Date(now - 60 * DAY).toISOString()),
			env.DB.prepare(
				"INSERT INTO invoice_lines (invoice_id, line, sku, description, quantity, unit_price) VALUES ('INV09999', 1, 'BRG-6310', 'X', 20, 9)",
			),
			env.DB.prepare(
				"INSERT INTO receipts (po_id, line, sku, quantity, unit_cost, at, by) VALUES ('PO09999', 1, 'BRG-6310', 10, 5, ?, 'T')",
			).bind(new Date(now - 30 * DAY).toISOString()),
		]);
		const t = await inventoryTurns(env.DB, now);
		expect(t.days).toBe(60);
		const p = t.items.find((p) => p.sku === "BRG-6310")!;
		// Opening stock 10 + 20 sold - 10 received = 20; average (20 + 10) / 2 = 15.
		// 20 / 15 in 60 days is 8.1 a year; 10 on hand at 20 per 60 days is 30 days.
		expect(p).toMatchObject({ sold: 20, received: 10, value: 50, days: 30 });
		expect(p.turns).toBeCloseTo((20 / 15) * (365 / 60), 5);
		expect(t.items.filter((q) => q.sku !== "BRG-6310").every((q) => q.turns === 0 && q.days === Infinity)).toBe(true);
	});
});
