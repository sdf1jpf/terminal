import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addLine, changeLine, createInvoice } from "../src/invoices";
import { breakFor, deletePromotion, priceLine, promotionFor, savePromotion, setBreak, setPricing, today } from "../src/sales";
import { Terminal } from "./term";

const db = env.DB;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("quantity breaks", () => {
	it("takes the largest break earned off the customer's price", async () => {
		await setBreak(db, "IBMUSER", { item: "PLT", qty: "100", disc: "5" });
		await setBreak(db, "IBMUSER", { item: "PLT", qty: "250", disc: "8" });
		await setBreak(db, "IBMUSER", { item: "*", qty: "50", disc: "2" });
		expect(await breakFor(db, "PLT-4848", 99)).toBeUndefined(); // PLT is more specific than *
		expect((await breakFor(db, "PLT-4848", 300))?.min_qty).toBe(250);
		expect((await breakFor(db, "SAF-GLV", 60))?.disc_pct10).toBe(20);

		await setPricing(db, "IBMUSER", "000104", { item: "PLT", disc: "10", price: "" });
		// list 14: 10% -> 13 (12.60), then 5% -> 12 (12.35)
		expect(await priceLine(db, "000104", "PLT-4848", 100, 14)).toEqual({ unit_price: 12, disc_pct10: 143, rule: "PLT 10% +QTY 5%" });

		const inv = await createInvoice(db, "IBMUSER", "000104");
		const line = await addLine(db, inv.id, "PLT-4848", 10);
		expect([line.unit_price, line.price_rule]).toEqual([13, "PLT 10%"]);
		const more = await changeLine(db, inv.id, line.line, 260);
		expect([more.unit_price, more.list_price, more.price_rule]).toEqual([12, 14, "PLT 10% +QTY 8%"]);
		await expect(setBreak(db, "IBMUSER", { item: "PLT", qty: "1", disc: "5" })).rejects.toThrow("from 2 to 99999");
	});
});

describe("promotions", () => {
	it("gives the lower of the promotion and the customer's price, while it runs", async () => {
		const p = await savePromotion(db, "IBMUSER", "", {
			description: "spring valve sale", item: "VLV", disc: "20", price: "", starts: "", ends: day(10),
		});
		expect(p).toMatchObject({ description: "SPRING VALVE SALE", item: "VLV", disc_pct10: 200, starts: today() });
		expect((await promotionFor(db, "VLV-0100", 27))?.id).toBe(p.id);
		expect(await promotionFor(db, "VLV-0100", 27, day(11))).toBeUndefined();
		expect(await priceLine(db, "000102", "VLV-0100", 1, 27)).toMatchObject({ unit_price: 22, rule: `PROMO ${p.id}` });

		// A better customer price wins.
		await setPricing(db, "IBMUSER", "000107", { item: "VLV-0100", disc: "", price: "18" });
		expect(await priceLine(db, "000107", "VLV-0100", 1, 27)).toMatchObject({ unit_price: 18, rule: "CONTRACT" });

		const future = await savePromotion(db, "IBMUSER", "", {
			description: "MOTOR WEEK", item: "MTR-0500", disc: "", price: "1500", starts: day(5), ends: day(12),
		});
		expect(await promotionFor(db, "MTR-0500", 1840)).toBeUndefined();
		expect(await priceLine(db, "000102", "MTR-0500", 1, 1840, day(6))).toMatchObject({ unit_price: 1500, rule: `PROMO ${future.id}` });
		await expect(savePromotion(db, "IBMUSER", "", { description: "X", item: "MTR", disc: "", price: "9", starts: "", ends: day(1) }))
			.rejects.toThrow("a promotional price is for one SKU");
		await expect(savePromotion(db, "IBMUSER", "", { description: "X", item: "MTR", disc: "5", price: "", starts: day(3), ends: day(1) }))
			.rejects.toThrow("must end on or after the day it starts");
		await deletePromotion(db, future.id);
		await deletePromotion(db, p.id);
	});
});

describe("screens", () => {
	it("keeps quantity breaks and promotions", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "6.6").send("ENTER");
		expect(t.scr.map).toBe("CUSC02");
		await t.fill("item", "brg").fill("qty", "500").fill("disc", "4").send("ENTER");
		expect(t.message).toBe("CUS0640I BRG AT 500 OR MORE NOW 4% EXTRA OFF");
		expect(t.row(11)).toMatch(/BRG +500 +4%/); // after *
		await t.fill("sel:BRG/500", "d").send("ENTER");
		expect(t.message).toBe("CUS0643I BREAK FOR BRG AT 500 DELETED");

		await t.send("PF3");
		await t.fill("option", "7").send("ENTER");
		expect(t.scr.map).toBe("CUSC03");
		await t.fill("desc", "glove days").fill("item", "saf-glv").fill("price", "45").fill("ends", day(3)).send("ENTER");
		expect(t.message).toMatch(/^CUS0650I PROMOTION PR\d{3} SAVED/);
		expect(t.row(11)).toMatch(/PR\d{3} +GLOVE DAYS +SAF-GLV +\$45/);
		await t.fill("ends", "tomorrow").fill("desc", "x").fill("item", "*").fill("disc", "5").send("ENTER");
		expect(t.message).toBe("CUS0655E DATES ARE YYYY-MM-DD");
	});
});
