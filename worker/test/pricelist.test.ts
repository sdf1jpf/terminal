import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { COMPANY } from "../src/documents";
import { ediCustomers, parse, sendCatalog } from "../src/edi";
import { priceCatalogs, priceLists, type Job } from "../src/jobs";
import { priceList, priceListLines, savePromotion, setBreak, setPricing } from "../src/sales";
import type { Env } from "../src/index";
import { Terminal } from "./term";

const db = env.DB;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// tradeByEDI files an accepted 850 from a customer, as if it had sent one.
async function tradeByEDI(cust: string) {
	await db.prepare(
		`INSERT INTO edi (id, direction, type, partner, control, status, reference, raw, created, created_by)
		 VALUES (?1, 'I', '850', ?2, '000000001', 'ACCEPTED', 'PO 1 INV00001', '', ?3, 'TEST')`,
	).bind(`EDI9${cust.slice(1)}`, cust, new Date().toISOString()).run();
}

describe("price lists", () => {
	it("prices every product for a customer, one at a time and at each break", async () => {
		await setPricing(db, "IBMUSER", "000110", { item: "BRG", disc: "10", price: "" });
		await setBreak(db, "IBMUSER", { item: "BRG", qty: "10", disc: "5" });
		await setBreak(db, "IBMUSER", { item: "BRG", qty: "50", disc: "10" });
		const promo = await savePromotion(db, "IBMUSER", "", {
			description: "glove days", item: "SAF-GLV", disc: "", price: "1", starts: "", ends: day(5),
		});

		const pl = await priceList(db, "000110");
		expect(pl.customer.id).toBe("000110");
		const brg = pl.items.find((i) => i.sku === "BRG-6310")!;
		// list 31: 10% -> 28, then 5% -> 27 and 10% -> 25
		expect(brg).toMatchObject({ list: 31, price: 28, rule: "BRG 10%", until: "", breaks: [{ qty: 10, price: 27 }, { qty: 50, price: 25 }] });
		const glv = pl.items.find((i) => i.sku === "SAF-GLV")!;
		expect(glv).toMatchObject({ price: 1, rule: `PROMO ${promo.id}`, until: day(5) });
		expect(pl.items.find((i) => i.sku === "PLT-4848")).toMatchObject({ list: 14, price: 14, rule: "" });

		const lines = priceListLines(pl, COMPANY.name);
		expect(lines.every((l) => l.length <= 80)).toBe(true);
		expect(lines.find((l) => l.startsWith("BRG-6310"))).toMatch(/\$31 +\$28  BRG 10%$/);
		expect(lines).toContain("           BY QUANTITY: 10+ $27  50+ $25");
		expect(lines.find((l) => l.startsWith("SAF-GLV"))).toContain(`PROMO ${promo.id} TO ${day(5).slice(5)}`);
	});

	it("sends the price list as an 832 catalog", async () => {
		const pl = await priceList(db, "000110");
		const sent = await sendCatalog(db, pl);
		expect(sent).toMatchObject({ direction: "O", type: "832", partner: "000110", status: "SENT" });
		expect(sent.reference).toMatch(/^PL000110\d{6}$/);
		const p = parse(sent.raw);
		expect(p.type).toBe("832");
		expect(sent.raw).toContain("~\nLIN**VP*BRG-6310~\n");
		expect(sent.raw).toContain("CTP**CAT*31*1*EA~\nCTP**CON*28*1*EA~\nCTP**CON*27*10*EA~\nCTP**CON*25*50*EA~");
		expect(sent.raw).toMatch(/CTP\*\*PRP\*1\*1\*EA~\nDTM\*036\*\d{8}~/);
		expect(sent.raw).toContain(`CTT*${pl.items.length}~`);
	});

	it("files price lists and sends catalogs to EDI customers in CUSPRICE", async () => {
		await tradeByEDI("000110");
		expect(await ediCustomers(db)).toContain("000110");
		const job = { id: "JOB09997", name: "CUSPRICE", submitted_by: "IBMUSER", started: new Date().toISOString(), submitted: "" } as Job;
		const run = await priceLists(db, job, env as unknown as Env);
		expect(run.rc).toBe(0);
		expect(run.lines.find((l) => l.includes("000110"))).toMatch(/BELOW LIST  EDI$/);
		const filed = await db.prepare("SELECT key, kind FROM archive WHERE archived_by = 'CUSPRICE' AND ref = '000110'").first<{ key: string; kind: string }>();
		expect(filed).toEqual({ key: `prices/${day(0)}/000110`, kind: "M" });
		const pdf = await env.ARCHIVE.get(`prices/${day(0)}/000110.pdf`);
		expect(new TextDecoder().decode((await pdf!.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

		const sent = await priceCatalogs(db);
		expect(sent.lines.some((l) => l.includes("000110") && l.includes("PL000110"))).toBe(true);
		expect(sent.lines.at(-1)).toMatch(/^\d+ CATALOGS SENT$/);
	});

	it("prints and sends a price list from the pricing panel", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.1 110").send("ENTER");
		expect(t.scr.map).toBe("CUSC01");
		await t.send("PF9");
		expect(t.message).toMatch(/^CUS0609I PRICE LIST PRINTED TO THE SPOOL AS \w+ - SEE OPTION 5.4$/);
		await t.send("PF10");
		expect(t.message).toMatch(/^CUS0608I 832 CATALOG PL000110\d{6} SENT AS EDI\d{5}, \d+ ITEMS$/);
		await t.fill("cust", "000111").send("ENTER");
		await t.send("PF10");
		expect(t.message).toBe("CUS0607E CUSTOMER 000111 DOES NOT TRADE BY EDI - PF9 PRINTS ITS PRICE LIST");
	});
});
