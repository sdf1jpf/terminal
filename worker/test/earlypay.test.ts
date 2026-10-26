import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bill, parse, partnerPO, partnerRemittance, processInterchange, receive } from "../src/edi";
import { addLine, createInvoice, earlyDiscount, payInvoice, termsText } from "../src/invoices";
import { journal, trialBalance } from "../src/ledger";
import { setEarlyPay } from "../src/sales";
import { customerEvents } from "../src/events";
import { Terminal } from "./term";
import { shipInvoice } from "./ship";

const db = env.DB;
const DAY = 86_400_000;

async function billed(cust: string, sku: string, qty: number) {
	const inv = await createInvoice(db, "IBMUSER", cust);
	await addLine(db, inv.id, sku, qty);
	await shipInvoice(db, inv.id);
	return bill(db, env.TABLES, "IBMUSER", inv.id);
}

describe("early-payment terms", () => {
	it("describes terms and works out the discount by date", () => {
		expect(termsText({ early_pct10: 0, early_days: 0 })).toBe("NET 30");
		expect(termsText({ early_pct10: 20, early_days: 10 })).toBe("2% 10 NET 30");
		expect(termsText({ early_pct10: 15, early_days: 15 })).toBe("1.5% 15 NET 30");
		const inv = { billed: "2026-10-01T15:00:00Z", subtotal: 1000, early_pct10: 20, early_days: 10 };
		expect(earlyDiscount(inv, "2026-10-11T23:59:00Z")).toBe(20);
		expect(earlyDiscount(inv, "2026-10-12T00:00:00Z")).toBe(0);
		expect(earlyDiscount({ ...inv, early_pct10: 0 }, "2026-10-02T00:00:00Z")).toBe(0);
	});

	it("bills on the customer's terms and takes the discount on early payment", async () => {
		await setEarlyPay(db, "IBMUSER", "000105", "2/10"); // EUGENE, OR: no sales tax
		expect((await customerEvents(db, "000105")).map((e) => e.text)).toContain("EARLY PAY (BLANK) > 2/10");
		const { invoice } = await billed("000105", "SAF-GLV", 10); // $520
		expect(invoice).toMatchObject({ total: 520, early_pct10: 20, early_days: 10 });
		const { invoice: paid, transaction } = await payInvoice(db, "IBMUSER", invoice.id);
		expect(paid).toMatchObject({ status: "P", discount_taken: 10 });
		expect(transaction.amount).toBe(520); // the account is cleared in full

		await journal(db, "TEST");
		const tb = await trialBalance(db);
		expect(tb.debits).toBe(tb.credits);
		const disc = await db.prepare("SELECT debit FROM gl_entries WHERE account = '4100' AND memo = ?").bind(`DISCOUNT ${invoice.id}`).first<{ debit: number }>();
		expect(disc?.debit).toBe(10);

		// Late, no discount.
		const late = (await billed("000105", "SAF-GLV", 1)).invoice;
		await db.prepare("UPDATE invoices SET billed = ? WHERE id = ?").bind(new Date(Date.now() - 12 * DAY).toISOString(), late.id).run();
		expect((await payInvoice(db, "IBMUSER", late.id)).invoice.discount_taken).toBe(0);
	});

	it("puts the terms on the 810 and accepts a discounted 820", async () => {
		await setEarlyPay(db, "IBMUSER", "000124", "1.5/15"); // BATH, ME: no sales tax in the table
		const filed = await receive(db, "TEST", partnerPO("000124", 900, "YC-1", [{ sku: "SAF-GLV", qty: 4, price: 52 }]));
		const po = (await processInterchange(db, filed.id))!;
		const id = po.reference.split(" ")[2];
		await shipInvoice(db, id);
		const out = await bill(db, env.TABLES, "IBMUSER", id);
		expect(parse(out.edi!.raw).body.find((s) => s[0] === "ITD")?.slice(0, 8)).toEqual(["ITD", "01", "3", "1.5", "", "15", "", "30"]);
		const short = await processInterchange(db, (await receive(db, "TEST", partnerRemittance("000124", 901, [{ id, total: 200 }]))).id);
		expect(short?.note).toBe(`INVOICE ${id} IS FOR 208 (OR 205 WITH THE EARLY-PAYMENT DISCOUNT), REMITTANCE SAYS 200`);
		const ok = await processInterchange(db, (await receive(db, "TEST", partnerRemittance("000124", 902, [{ id, total: 205 }]))).id);
		expect(ok?.status).toBe("ACCEPTED");
		const row = await db.prepare("SELECT status, discount_taken FROM invoices WHERE id = ?").bind(id).first();
		expect(row).toEqual({ status: "P", discount_taken: 3 });
	});

	it("is set on the pricing screen", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.1 102").send("ENTER");
		await t.fill("early", "2/10").send("ENTER");
		expect(t.message).toBe("CUS0602I 000102 NOW TERMS 2% 10 NET 30");
		expect(t.field("early")?.value).toBe("2/10");
		await t.fill("early", "2").send("ENTER");
		expect(t.message).toBe("CUS0604E EARLY-PAYMENT TERMS ARE PERCENT/DAYS, SUCH AS 2/10");
		await expect(setEarlyPay(db, "IBMUSER", "000102", "2/45")).rejects.toThrow("within 1 to 29 days");
	});
});
