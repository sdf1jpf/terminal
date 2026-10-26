import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accessJWT } from "./access";
import { Terminal } from "./term";
import { partnerPO, processInterchange, receive } from "../src/edi";
import { correctException, dropException, listExceptions, openExceptions, rejectOrder } from "../src/ediexceptions";
import { getInvoice } from "../src/invoices";
import { getFlow, lookAtInvoice, timeline } from "../src/lifecycle";
import { release } from "../src/shipping";
import { HttpError } from "../src/http";

const db = env.DB;
const worker = (exports as unknown as { default: Fetcher }).default;

async function deliver(raw: string) {
	const filed = await receive(db, "TEST", raw);
	return (await processInterchange(db, filed.id))!;
}

const onHand = async (sku: string) =>
	(await db.prepare("SELECT on_hand FROM products WHERE sku = ?").bind(sku).first<{ on_hand: number }>())!.on_hand;

async function refused(fn: () => Promise<unknown>): Promise<HttpError> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof HttpError) return e;
		throw e;
	}
	throw new Error("expected an error");
}

describe("EDI exceptions", () => {
	it("holds lines for products we do not carry instead of rejecting the order", async () => {
		const x = await deliver(partnerPO("000111", 701, "X-1", [
			{ sku: "SAF-GLV", qty: 2, price: 52 },
			{ sku: "XYZ-9999", qty: 4, price: 7 },
			{ sku: "WLD-7018", qty: 1, price: 9 }, // discontinued in the seed
		]));
		expect(x).toMatchObject({ status: "ACCEPTED", note: "2 LINES HELD FOR CORRECTION - OPTION 2.5" });
		const inv = x.reference.split(" ")[2];
		const held = await openExceptions(db, inv);
		expect(held.map((h) => [h.po_line, h.sku, h.quantity, h.problem])).toEqual([
			["2", "XYZ-9999", 4, "PRODUCT NOT ON FILE"],
			["3", "WLD-7018", 1, "PRODUCT DISCONTINUED"],
		]);
		expect((await getInvoice(db, inv)).lines.map((l) => l.sku)).toEqual(["SAF-GLV"]);

		// The order waits: no release, and the lifecycle says why.
		expect((await refused(() => release(db, "IBMUSER", inv))).message).toMatch(/2 EDI line\(s\) held for correction/);
		await lookAtInvoice(db, inv);
		expect((await getFlow(db, "I", inv))!.next).toBe("CORRECTION OF 2 HELD EDI LINES - OPTION 2.5");

		// Correcting adds the product for the quantity ordered.
		const bearings = await onHand("BRG-6204");
		const { line } = await correctException(db, "IBMUSER", held[0].seq, "brg-6204");
		expect(line).toMatchObject({ sku: "BRG-6204", quantity: 4 });
		expect(await onHand("BRG-6204")).toBe(bearings - 4);
		expect((await refused(() => correctException(db, "IBMUSER", held[0].seq, "BRG-6204"))).message).toBe(`exception ${held[0].seq} is already corrected`);
		// A bad correction leaves it open.
		expect((await refused(() => correctException(db, "IBMUSER", held[1].seq, "NOPE"))).message).toBe("product NOPE is not on file");
		expect((await openExceptions(db, inv)).length).toBe(1);

		await dropException(db, "IBMUSER", held[1].seq);
		expect(await openExceptions(db, inv)).toEqual([]);
		await lookAtInvoice(db, inv);
		expect((await getFlow(db, "I", inv))!.next).toBe("RELEASE TO THE WAREHOUSE");
		expect((await timeline(db, "I", inv)).map((e) => e.event)).toEqual(expect.arrayContaining(["EDI HELD", "CORRECTED", "DROPPED"]));
		expect((await release(db, "IBMUSER", inv)).invoice_id).toBe(inv);
	});

	it("rejects a whole order on request, returning the stock", async () => {
		const gloves = await onHand("SAF-GLV");
		const x = await deliver(partnerPO("000111", 702, "X-2", [{ sku: "SAF-GLV", qty: 3, price: 52 }, { sku: "ZZZ", qty: 1, price: 1 }]));
		const inv = x.reference.split(" ")[2];
		const [held] = await openExceptions(db, inv);
		await rejectOrder(db, "IBMUSER", held.seq);
		expect(await onHand("SAF-GLV")).toBe(gloves);
		expect(await db.prepare("SELECT 1 FROM invoices WHERE id = ?").bind(inv).first()).toBeNull();
		const edi = await db.prepare("SELECT status, note FROM edi WHERE id = ?").bind(x.id).first();
		expect(edi).toEqual({ status: "REJECTED", note: "ORDER REJECTED BY IBMUSER: PO1 LINE 2 PRODUCT NOT ON FILE" });
		expect((await listExceptions(db, true)).find((e) => e.seq === held.seq)?.status).toBe("X");
	});

	it("corrects held lines on CUSE03 and over the API", async () => {
		const x = await deliver(partnerPO("000116", 703, "X-3", [{ sku: "QQQ-1", qty: 2, price: 5 }, { sku: "QQQ-2", qty: 1, price: 5 }]));
		const inv = x.reference.split(" ")[2];
		const [a, b] = await openExceptions(db, inv);

		const t = await Terminal.logon();
		await t.fill("option", "2.5").send("ENTER");
		expect(t.scr.map).toBe("CUSE03");
		expect(t.row(9)).toContain(`${inv} 000116 X-3`);
		// F finds a product; S carries it back.
		await t.fill(`sel:${a.seq}`, "f").send("ENTER");
		expect(t.scr.map).toBe("CUSI03");
		await t.fill("q", "BRG").send("ENTER");
		await t.fill("sel:BRG-6204", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSE03");
		expect(t.field(`sku:${a.seq}`)?.value).toBe("BRG-6204");
		await t.send("ENTER");
		expect(t.message).toBe(`CUS0541I BRG-6204 ADDED TO ${inv} AS LINE 1 FOR PO1 LINE 1`);

		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT(), "Content-Type": "application/json" };
		const list = await worker.fetch("https://api.test/v1/edi/exceptions", { headers });
		expect((await list.json<{ seq: number }[]>()).map((e) => e.seq)).toContain(b.seq);
		const res = await worker.fetch(`https://api.test/v1/edi/exceptions/${b.seq}/correct`, {
			method: "POST", headers, body: JSON.stringify({ sku: "TAP-DUCT" }),
		});
		expect(res.status).toBe(200);
		expect(await openExceptions(db, inv)).toEqual([]);
		expect((await getInvoice(db, inv)).lines.map((l) => l.sku)).toEqual(["BRG-6204", "TAP-DUCT"]);
		const again = await worker.fetch(`https://api.test/v1/edi/exceptions/${b.seq}/drop`, { method: "POST", headers });
		expect(again.status).toBe(422);
	});
});
