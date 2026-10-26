import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { customerEvents } from "../src/events";
import { addLine, billInvoice, createInvoice, payInvoice } from "../src/invoices";
import { closePeriod, dunningLetters, journal, journalStep, openPeriod, trialBalance, trialBalanceStep } from "../src/ledger";
import { createProduct, getProduct, updateProduct } from "../src/products";
import { shipInvoice } from "./ship";

const db = env.DB;
const DAY = 86_400_000;

async function sale(cust: string, sku: string, qty: number) {
	const inv = await createInvoice(db, "IBMUSER", cust);
	await addLine(db, inv.id, sku, qty);
	await shipInvoice(db, inv.id);
	return (await billInvoice(db, "IBMUSER", inv.id)).invoice;
}

describe("general ledger", () => {
	it("journals the subledgers once, balances, and closes the period", async () => {
		const first = await journal(db, "TEST");
		expect(first.entries).toBeGreaterThan(0);
		let tb = await trialBalance(db);
		expect(tb.debits).toBe(tb.credits);
		const ar = () => tb.rows.find((r) => r.account === "1200")!;
		expect(ar().debit).toBe(tb.subledger);
		expect(tb.unjournaled).toBe(0);
		expect((await journal(db, "TEST")).entries).toBe(0);

		// A sale and its payment: AR, sales, cost of goods, cash.
		const inv = await sale("000107", "BRG-6310", 10); // 10 at $31, cost $19
		await payInvoice(db, "IBMUSER", inv.id);
		tb = await trialBalance(db);
		expect(tb.unjournaled).toBe(3); // the invoice, the payment and the freight to ship it
		const step = await journalStep(db, { name: "CUSTRIAL" });
		expect(step.rc).toBe(0);
		expect(step.lines.find((l) => l.startsWith("5000"))).toMatch(/COST OF GOODS SOLD +\$190 *$/);
		expect(step.lines.at(-1)).toBe("8 ENTRIES POSTED");
		tb = await trialBalance(db);
		expect(tb.debits).toBe(tb.credits);
		expect(ar().debit).toBe(tb.subledger);
		expect(tb.rows.find((r) => r.account === "4000")!.activity).toBeLessThanOrEqual(-310);

		const report = await trialBalanceStep(db);
		expect(report.rc).toBe(0);
		expect(report.lines).toContain("DEBITS EQUAL CREDITS - THE LEDGER IS IN BALANCE");
		expect(report.lines.at(-1)).toMatch(/AGREE$/);

		const { period } = await openPeriod(db);
		const { closed, opened } = await closePeriod(db, "CUSCLOSE");
		expect(closed).toBe(period);
		expect((await openPeriod(db)).period).toBe(opened);
		expect((await trialBalance(db, closed)).period).toMatchObject({ status: "C", closed_by: "CUSCLOSE" });

		// Later activity goes to the new period; the balances carry forward.
		await sale("000107", "PLT-4848", 2);
		const later = await journal(db, "TEST");
		expect(later.period).toBe(opened);
		tb = await trialBalance(db);
		expect(tb.rows.find((r) => r.account === "4000")!.activity).toBe(-28);
		expect(ar().debit).toBe(tb.subledger);
	});
});

describe("stock adjustments", () => {
	it("journals hand edits of stock and cost, and the books still balance", async () => {
		await journal(db, "TEST");
		const inventory = async () => (await trialBalance(db)).rows.find((r) => r.account === "1300")!.debit;
		const before = await inventory();

		// A count finds 5 more bearings at $5 cost: +$25.
		const p = await getProduct(db, "BRG-6204");
		const edit = { ...p, on_hand: p.on_hand + 5 };
		let saved = await updateProduct(db, p.sku, edit, p.version, "CLERK");
		expect((await trialBalance(db)).unjournaled).toBe(1);
		let run = await journal(db, "TEST");
		expect(run.entries).toBe(2);
		expect(run.byAccount.get("1300")).toEqual({ debit: 5 * p.unit_cost, credit: 0 });
		expect(run.byAccount.get("5100")).toEqual({ debit: 0, credit: 5 * p.unit_cost });
		expect(await inventory()).toBe(before + 5 * p.unit_cost);

		// Then 2 are found damaged and the cost goes up a dollar.
		saved = await updateProduct(db, p.sku, { ...saved, on_hand: saved.on_hand - 2, unit_cost: p.unit_cost + 1 }, saved.version, "CLERK");
		const change = saved.on_hand * saved.unit_cost - (p.on_hand + 5) * p.unit_cost;
		run = await journal(db, "TEST");
		const [gain, loss] = change > 0 ? ["1300", "5100"] : ["5100", "1300"];
		expect(run.byAccount.get(gain)!.debit).toBe(Math.abs(change));
		expect(run.byAccount.get(loss)!.credit).toBe(Math.abs(change));
		const entry = await db.prepare("SELECT memo FROM gl_entries WHERE account = '5100' ORDER BY seq DESC LIMIT 1").first<{ memo: string }>();
		expect(entry!.memo).toBe(`ADJUST BRG-6204 -2 AT $${p.unit_cost + 1}`);

		// Changing only the description is not an adjustment; a new product's stock is.
		await updateProduct(db, p.sku, { ...saved, description: "BALL BEARING 6204" }, saved.version, "CLERK");
		await createProduct(db, { sku: "NUT-0001", description: "HEX NUT", unit_price: 1, on_hand: 100, reorder_point: 0, status: "A", vendor: "", unit_cost: 1 }, "CLERK");
		run = await journal(db, "TEST");
		expect(run.entries).toBe(2);
		expect(run.byAccount.get("1300")).toEqual({ debit: 100, credit: 0 });

		const tb = await trialBalance(db);
		expect(tb.debits).toBe(tb.credits);
		expect(tb.unjournaled).toBe(0);
		expect(await inventory()).toBe(
			(await db.prepare("SELECT SUM(on_hand * unit_cost) AS v FROM products").first<{ v: number }>())!.v
			+ (await db.prepare(`SELECT COALESCE(SUM(l.quantity * p.unit_cost), 0) AS v FROM invoice_lines l JOIN products p ON p.sku = l.sku
			                     JOIN invoices i ON i.id = l.invoice_id WHERE i.status = 'O'`).first<{ v: number }>())!.v,
		);
	});

	it("is refused, with nothing recorded, when the product changed underneath", async () => {
		const p = await getProduct(db, "TAP-DUCT");
		await updateProduct(db, p.sku, { ...p, on_hand: p.on_hand + 1 }, p.version, "A");
		const n = async () => (await db.prepare("SELECT COUNT(*) AS n FROM stock_adjustments").first<{ n: number }>())!.n;
		const count = await n();
		await expect(updateProduct(db, p.sku, { ...p, on_hand: p.on_hand + 9 }, p.version, "B")).rejects.toThrow(/changed by another user/);
		expect(await n()).toBe(count);
	});
});

describe("dunning", () => {
	it("writes once per level and holds the account on a final notice", async () => {
		const young = await sale("000121", "SAF-GLV", 1);
		const old = await sale("000121", "TAP-DUCT", 1);
		const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
		await db.prepare("UPDATE invoices SET billed = ? WHERE id = ?").bind(ago(45), young.id).run();
		await db.prepare("UPDATE invoices SET billed = ? WHERE id = ?").bind(ago(100), old.id).run();

		const run = await dunningLetters(db, { name: "CUSDUNN" });
		expect(run.rc).toBe(4);
		expect(run.lines.some((l) => l.includes("FINAL NOTICE"))).toBe(true);
		expect(run.lines.find((l) => l.trim().startsWith(young.id))).toMatch(/ 15 +\$52$/);
		expect(run.lines.find((l) => l.trim().startsWith(old.id))).toMatch(/ 70 +\$88$/);
		expect(run.lines.at(-1)).toMatch(/1 ACCOUNTS PLACED ON HOLD$/);
		const cust = await db.prepare("SELECT status FROM customers WHERE id = '000121'").first<{ status: string }>();
		expect(cust?.status).toBe("H");

		const again = await dunningLetters(db, { name: "CUSDUNN" });
		expect(again.lines.some((l) => l.includes("000121"))).toBe(false);

		const events = await customerEvents(db, "000121");
		const dunned = events.filter((e) => e.event === "DUNNING").map((e) => e.text);
		expect(dunned).toEqual(expect.arrayContaining([`REMINDER ${young.id} $52`, `FINAL NOTICE ${old.id} $88`]));
		expect(events.some((e) => e.kind === "A" && e.by === "CUSDUNN" && e.text === "STATUS A > H")).toBe(true);
	});
});
