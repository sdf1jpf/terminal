import { env, exports } from "cloudflare:workers";
import { accessJWT } from "./access";
import { describe, expect, it } from "vitest";
import { bill, parse, partnerPO, processInterchange, receive } from "../src/edi";
import { addLine, createInvoice, getInvoice } from "../src/invoices";
import {
	assign, assignment, deletePricing, listPricing, netPrice, pricingFor, salesBy, saveSalesperson, saveTerritory, setPricing,
} from "../src/sales";
import { customerEvents } from "../src/events";
import { Terminal } from "./term";
import { shipInvoice } from "./ship";

const db = env.DB;
const month = () => new Date().toISOString().slice(0, 7);

describe("pricing", () => {
	it("rounds a discount to the dollar", () => {
		expect(netPrice(9, { disc_pct10: 100, price: 0 })).toBe(8); // 8.10
		expect(netPrice(18, { disc_pct10: 125, price: 0 })).toBe(16); // 15.75
		expect(netPrice(1840, { disc_pct10: 0, price: 1700 })).toBe(1700);
	});

	it("prices a line by the most specific agreement", async () => {
		await setPricing(db, "IBMUSER", "000111", { item: "*", disc: "5", price: "" });
		await setPricing(db, "IBMUSER", "000111", { item: "brg", disc: "12.5", price: "" });
		await setPricing(db, "IBMUSER", "000111", { item: "BRG-6310", disc: "", price: "$25" });
		expect((await listPricing(db, "000111")).map((p) => p.item)).toEqual(["*", "BRG", "BRG-6310"]);
		expect(await pricingFor(db, "000111", "BRG-6310")).toEqual({ disc_pct10: 0, price: 25, rule: "CONTRACT" });
		expect(await pricingFor(db, "000111", "BRG-6204")).toEqual({ disc_pct10: 125, price: 0, rule: "BRG 12.5%" });
		expect(await pricingFor(db, "000111", "SAF-GLV")).toEqual({ disc_pct10: 50, price: 0, rule: "ALL 5%" });
		expect(await pricingFor(db, "000102", "SAF-GLV")).toEqual({ disc_pct10: 0, price: 0, rule: "" });

		const inv = await createInvoice(db, "IBMUSER", "000111");
		const a = await addLine(db, inv.id, "BRG-6310", 2); // list 31
		const b = await addLine(db, inv.id, "BRG-6204", 10); // list 9 -> 7.875
		const c = await addLine(db, inv.id, "SAF-GLV", 1); // list 52 -> 49.4
		expect([a, b, c].map((l) => [l.unit_price, l.list_price, l.price_rule])).toEqual([
			[25, 31, "CONTRACT"], [8, 9, "BRG 12.5%"], [49, 52, "ALL 5%"],
		]);
		const { invoice } = await getInvoice(db, inv.id);
		expect(invoice.total).toBe(2 * 25 + 10 * 8 + 49);

		const events = await customerEvents(db, "000111");
		expect(events.map((e) => e.text)).toContain("PRICE BRG-6310 (BLANK) > $25 CONTRACT");
		await deletePricing(db, "IBMUSER", "000111", "*");
		expect((await listPricing(db, "000111")).map((p) => p.item)).toEqual(["BRG", "BRG-6310"]);
	});

	it("checks what is typed", async () => {
		const bad = (f: { item: string; disc: string; price: string }) => setPricing(db, "IBMUSER", "000102", f);
		await expect(bad({ item: "XYZ", disc: "5", price: "" })).rejects.toThrow("XYZ is not a SKU or product line on file");
		await expect(bad({ item: "BRG", disc: "5", price: "7" })).rejects.toThrow("either a discount percentage or a contract price");
		await expect(bad({ item: "BRG", disc: "", price: "7" })).rejects.toThrow("a contract price is for one SKU");
		await expect(bad({ item: "BRG", disc: "95", price: "" })).rejects.toThrow("limited to 90%");
		await expect(bad({ item: "BRG", disc: "1.25", price: "" })).rejects.toThrow("such as 10 or 3.5");
	});

	it("discounts an 850 and sends the 810 at list with allowances", async () => {
		await setPricing(db, "IBMUSER", "000113", { item: "SAF", disc: "10", price: "" });
		const filed = await receive(db, "TEST", partnerPO("000113", 501, "AG-77", [
			{ sku: "SAF-GLV", qty: 2, price: 52 },
			{ sku: "BRG-6204", qty: 4, price: 9 },
		]));
		const po = (await processInterchange(db, filed.id))!;
		expect(po.status).toBe("ACCEPTED");
		const id = po.reference.split(" ")[2];
		const { invoice, lines } = await getInvoice(db, id);
		expect(lines.map((l) => [l.sku, l.unit_price, l.list_price])).toEqual([["SAF-GLV", 47, 52], ["BRG-6204", 9, 9]]);
		expect(invoice.total).toBe(2 * 47 + 4 * 9);

		await shipInvoice(db, id);
		const billed = await bill(db, env.TABLES, "IBMUSER", id);
		const body = parse(billed.edi!.raw).body;
		expect(body.filter((s) => s[0] === "IT1").map((s) => [s[7], s[4]])).toEqual([["SAF-GLV", "52"], ["BRG-6204", "9"]]);
		const sac = body.filter((s) => s[0] === "SAC");
		expect(sac).toHaveLength(1);
		expect(sac[0].slice(0, 6)).toEqual(["SAC", "A", "C310", "", "", "1000"]);
		expect(sac[0][15]).toBe("SAF 10%");
		expect(body.find((s) => s[0] === "TDS")?.[1]).toBe(String(invoice.total * 100));
	});
});

describe("territories", () => {
	it("assigns customers by state unless told otherwise", async () => {
		expect(await assignment(db, "000101")).toMatchObject({
			territory: "MW", territory_name: "MIDWEST", territory_assigned: false, salesperson: "S02", salesperson_assigned: false,
		});
		const inv = await createInvoice(db, "IBMUSER", "000101");
		expect(inv).toMatchObject({ territory: "MW", salesperson: "S02" });

		expect(await assign(db, "IBMUSER", "000101", { territory: "ne", salesperson: "" })).toMatchObject({
			territory: "NE", territory_assigned: true, salesperson: "S01", salesperson_assigned: false,
		});
		expect(await assign(db, "IBMUSER", "000101", { territory: "NE", salesperson: "S03" })).toMatchObject({
			territory: "NE", salesperson: "S03", salesperson_name: "ROSA DELGADO", salesperson_assigned: true,
		});
		expect(await createInvoice(db, "IBMUSER", "000101")).toMatchObject({ territory: "NE", salesperson: "S03" });
		// The first invoice stays with who sold it.
		expect((await getInvoice(db, inv.id)).invoice).toMatchObject({ territory: "MW", salesperson: "S02" });
		await expect(assign(db, "IBMUSER", "000101", { territory: "ZZ", salesperson: "" })).rejects.toThrow("territory ZZ is not on file");
		await assign(db, "IBMUSER", "000101", { territory: "", salesperson: "" });
		expect(await assignment(db, "000101")).toMatchObject({ territory: "MW", salesperson: "S02" });
		expect((await customerEvents(db, "000101")).map((e) => e.text)).toContain("SALESREP (BLANK) > S03");
	});

	it("moves states between territories", async () => {
		const sp = await saveSalesperson(db, "IBMUSER", "", { name: "pat lee", comm: "2.5", status: "" });
		expect(sp).toMatchObject({ id: "S05", name: "PAT LEE", comm_pct10: 25, status: "A" });
		const t = await saveTerritory(db, "IBMUSER", { code: "pnw", name: "pacific northwest", salesperson: "S05", states: "or, wa ak" });
		expect(t).toMatchObject({ code: "PNW", salesperson: "S05", states: ["AK", "OR", "WA"] });
		expect(await assignment(db, "000105")).toMatchObject({ territory: "PNW", salesperson: "S05" }); // EUGENE, OR
		await expect(saveSalesperson(db, "IBMUSER", "S05", { name: "PAT LEE", comm: "2.5", status: "I" }))
			.rejects.toThrow("S05 still covers territory PNW");
		await expect(saveTerritory(db, "IBMUSER", { code: "PNW", name: "X", salesperson: "", states: "OREGON" }))
			.rejects.toThrow("OREGON is not a two letter state code");
	});
});

describe("sales report", () => {
	it("totals billed invoices by territory and salesperson, with commission", async () => {
		await setPricing(db, "IBMUSER", "000116", { item: "*", disc: "10", price: "" }); // GREENSBORO, NC: SO, S03
		const inv = await createInvoice(db, "IBMUSER", "000116");
		await addLine(db, inv.id, "SAF-GLV", 10); // list 520, net 470
		await shipInvoice(db, inv.id);
		await bill(db, env.TABLES, "IBMUSER", inv.id);

		const byTerr = await salesBy(db, "T", month());
		const so = byTerr.find((r) => r.key === "SO")!;
		expect(so.net).toBeGreaterThanOrEqual(470);
		expect(so.discount).toBeGreaterThanOrEqual(50);
		expect(byTerr.map((r) => r.key)).toEqual(expect.arrayContaining(["NE", "MW", "SO", "WE"]));

		const byRep = await salesBy(db, "S", month());
		const s03 = byRep.find((r) => r.key === "S03")!;
		expect(s03.comm_pct10).toBe(40);
		expect(s03.commission).toBe(Math.round((s03.net * 40) / 1000));
		expect(await salesBy(db, "S", "1999-01")).toSatisfy((rows: { net: number }[]) => rows.every((r) => r.net === 0));
	});
});

describe("sales screens", () => {
	it("sets a customer's pricing and salesperson", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.1 117").send("ENTER");
		expect(t.scr.map).toBe("CUSC01");
		expect(t.row(4)).toContain("QUARRY ROCK & GRAVEL");
		expect(t.row(5)).toContain("NE NORTHEAST - BY STATE VT");
		expect(t.row(12)).toContain("NO PRICING AGREEMENTS");

		await t.fill("item", "blt").fill("disc", "15").send("ENTER");
		expect(t.message).toBe("CUS0602I 000117 NOW BLT AT 15% OFF");
		expect(t.row(12)).toMatch(/BLT +15% OFF +PRODUCT LINE, 2 SKUS/);

		await t.fill("rep", "s04").send("ENTER");
		expect(t.message).toBe("CUS0602I 000117 NOW SOLD BY NE/S04");
		expect(t.row(6)).toContain("S04 TOM WHITEHORSE - ASSIGNED");

		await t.fill("sel:BLT", "d").send("ENTER");
		expect(t.message).toBe("CUS0603I PRICING FOR BLT DELETED");

		await t.fill("item", "BLT").fill("disc", "abc").send("ENTER");
		expect(t.message).toBe("CUS0604E PERCENTAGE MUST BE A NUMBER SUCH AS 10 OR 3.5");
	});

	it("lists territories and salespeople and the sales report", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.2").send("ENTER");
		expect(t.scr.map).toBe("CUSG01");
		expect(t.row(10)).toMatch(/^ +MW +MIDWEST +S02 /);
		await t.fill("sel:SO", "u").send("ENTER");
		expect(t.message).toBe("CUS0612I CHANGE SO ABOVE AND PRESS ENTER");
		await t.send("PF3");

		await t.fill("option", "6.3").send("ENTER");
		expect(t.scr.map).toBe("CUSG02");
		expect(t.row(10)).toMatch(/S01 MARGARET OKAFOR +4% +\$40,000  ACTIVE/);

		await t.send("PF3");
		await t.fill("option", "6.5").send("ENTER");
		expect(t.scr.map).toBe("CUSG03");
		expect(t.row(1)).toContain("SALES BY SALESPERSON");
		expect(t.row(6)).toMatch(/ID +NAME +INVS +NET SALES +QUOTA +MADE +COMM +COMMISSION/);
		await t.send("PF6");
		expect(t.row(1)).toContain("SALES BY TERRITORY");
		const [y, m] = month().split("-").map(Number);
		await t.send("PF10");
		expect(t.field("month")?.value).toBe(new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7));
		await t.fill("month", "13").send("ENTER");
		expect(t.message).toMatch(/^CUS0630E MONTH MUST BE YYYY-MM/);
	});
});

describe("sales API", () => {
	const worker = (exports as unknown as { default: Fetcher }).default;
	async function call(token: string, method: string, path: string, body?: unknown) {
		const res = await worker.fetch(`https://api.test${path}`, {
			method,
			headers: { "Cf-Access-Jwt-Assertion": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	}

	it("prices, assigns and reports", async () => {
		const token = await accessJWT();
		expect((await call(token, "PUT", "/v1/customers/000119/pricing/VLV", { discount: 7.5 })).body)
			.toMatchObject({ customer_id: "000119", item: "VLV", disc_pct10: 75, price: 0 });
		expect((await call(token, "PUT", "/v1/customers/000119/pricing/VLV-0100", { price: 20 })).body).toMatchObject({ price: 20 });
		expect((await call(token, "PUT", "/v1/customers/000119/sales", { territory: "", salesperson: "S01" })).body)
			.toMatchObject({ territory: "SO", salesperson: "S01", salesperson_assigned: true });
		const got = await call(token, "GET", "/v1/customers/000119/sales");
		expect(got.body.pricing.map((p: { item: string }) => p.item)).toEqual(["VLV", "VLV-0100"]);
		expect((await call(token, "DELETE", "/v1/customers/000119/pricing/vlv")).status).toBe(204);
		expect((await call(token, "GET", "/v1/territories")).body.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(["MW", "NE", "SO", "WE"]));
		expect((await call(token, "GET", "/v1/salespeople")).body[0]).toMatchObject({ id: "S01", comm_pct10: 40 });
		expect((await call(token, "GET", "/v1/sales?by=S&month=2020-01")).status).toBe(200);
		expect((await call(token, "GET", "/v1/sales?by=X")).status).toBe(400);
		expect((await call(token, "POST", "/v1/sales")).status).toBe(405);
	});
});
