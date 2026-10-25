import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { customerEvents } from "../src/events";
import { addLine, billInvoice, createInvoice, payInvoice } from "../src/invoices";
import { closePeriod, dunningLetters, journal, journalStep, openPeriod, trialBalance, trialBalanceStep } from "../src/ledger";
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
		expect(tb.unjournaled).toBe(2);
		const step = await journalStep(db, { name: "CUSTRIAL" });
		expect(step.rc).toBe(0);
		expect(step.lines.find((l) => l.startsWith("5000"))).toMatch(/COST OF GOODS SOLD +\$190 *$/);
		expect(step.lines.at(-1)).toBe("6 ENTRIES POSTED");
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
