import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bill } from "../src/edi";
import { addLine, createInvoice, getInvoice, salesTax, taxOn } from "../src/invoices";
import { journal, trialBalance } from "../src/ledger";
import { invoicePdf } from "../src/documents";
import { getCustomer } from "../src/data";
import { setTaxExempt } from "../src/sales";
import { customerEvents } from "../src/events";
import { Terminal } from "./term";
import { shipInvoice } from "./ship";

const db = env.DB;

async function billed(cust: string, sku: string, qty: number) {
	const inv = await createInvoice(db, "IBMUSER", cust);
	await addLine(db, inv.id, sku, qty);
	await shipInvoice(db, inv.id);
	return (await bill(db, env.TABLES, "IBMUSER", inv.id)).invoice;
}

describe("sales tax", () => {
	it("looks up the rate for the ship-to state", async () => {
		expect(await salesTax(env.TABLES, "OH", "")).toEqual({ rate: 5.75, note: "OH 5.75%" });
		expect(await salesTax(env.TABLES, "OR", "")).toEqual({ rate: 0, note: "NO TAX IN OR" });
		expect(await salesTax(env.TABLES, "OH", "EX-1")).toEqual({ rate: 0, note: "EXEMPT EX-1" });
		expect(taxOn(24, 5.75)).toBe(1);
		expect(taxOn(1000, 6.25)).toBe(63);
	});

	it("taxes an invoice when it is billed and journals the tax as owed", async () => {
		const open = await createInvoice(db, "IBMUSER", "000101"); // DAYTON, OH
		await addLine(db, open.id, "SAF-GLV", 10); // $520
		expect((await getInvoice(db, open.id)).invoice).toMatchObject({ subtotal: 520, total: 520, tax: 0, tax_note: "" });
		await shipInvoice(db, open.id);
		const { invoice } = await bill(db, env.TABLES, "IBMUSER", open.id);
		expect(invoice).toMatchObject({ status: "B", subtotal: 520, tax: 30, total: 550, tax_note: "OH 5.75%" });
		const cust = await getCustomer(db, "000101");
		const tx = await db.prepare("SELECT amount FROM transactions WHERE reference = ?").bind(open.id).first<{ amount: number }>();
		expect(tx?.amount).toBe(550);

		await journal(db, "TEST");
		const tb = await trialBalance(db);
		expect(tb.debits).toBe(tb.credits);
		const tax = await db.prepare("SELECT SUM(credit) AS c FROM gl_entries WHERE account = '2200' AND memo = ?").bind(`TAX ON ${open.id}`).first<{ c: number }>();
		expect(tax?.c).toBe(30);
		expect(cust.balance).toBeGreaterThan(0);
		expect(invoicePdf(invoice, (await getInvoice(db, open.id)).lines, cust).length).toBeGreaterThan(0);
	});

	it("does not tax an exempt customer or an untaxed state", async () => {
		await setTaxExempt(db, "IBMUSER", "000111", "pa-77-123"); // BETHLEHEM, PA
		const exempt = await billed("000111", "SAF-GLV", 2);
		expect(exempt).toMatchObject({ tax: 0, total: 104, tax_note: "EXEMPT PA-77-123" });
		expect((await customerEvents(db, "000111")).map((e) => e.text)).toContain("TAX EXEMPT (BLANK) > PA-77-123");
		const oregon = await billed("000105", "SAF-GLV", 1); // EUGENE, OR
		expect(oregon).toMatchObject({ tax: 0, total: 52, tax_note: "NO TAX IN OR" });
		await expect(setTaxExempt(db, "IBMUSER", "000111", "no way!")).rejects.toThrow("letters, digits and dashes");
	});

	it("shows the estimated and the charged tax on the invoice screen", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.1 109").send("ENTER");
		expect(t.row(7)).toContain("TAXABLE");
		await t.send("PF3");
		await t.fill("option", "=2.1 109").send("ENTER");
		await t.send("PF5");
		await t.fill("sku", "SAF-GLV").fill("qty", "2").send("ENTER");
		expect(t.row(8)).toContain("EST TAX IN 7% $7");
	});
});
