import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	bill, EdiError, getInterchange, interchange, listInterchanges, parse, partnerPO, partnerRemittance, partnersOrder, partnersPay,
	processInterchange, receive,
} from "../src/edi";
import { getInvoice } from "../src/invoices";
import { customerEvents } from "../src/events";
import { accessJWT } from "./access";

const db = env.DB;
const worker = (exports as unknown as { default: Fetcher }).default;

const onHand = async (sku: string) =>
	(await db.prepare("SELECT on_hand FROM products WHERE sku = ?").bind(sku).first<{ on_hand: number }>())!.on_hand;

// deliver files an inbound interchange and processes it, as the queue
// consumer would.
async function deliver(raw: string) {
	const filed = await receive(db, "TEST", raw);
	return (await processInterchange(db, filed.id))!;
}

// ack finds the 997 sent for an inbound interchange.
async function ack(id: string) {
	const row = await db.prepare("SELECT * FROM edi WHERE type = '997' AND reference LIKE ?").bind(`${id} %`).first<{ raw: string }>();
	return row?.raw ?? "";
}

describe("X12", () => {
	it("builds an envelope that parses back", () => {
		const raw = partnerPO("000109", 42, "PO-1", [{ sku: "BRG-6204", qty: 3, price: 9 }]);
		expect(raw.split("\n")[0]).toHaveLength(106);
		const p = parse(raw);
		expect(p).toMatchObject({ sender: "000109", receiver: "CUSTAPI", control: "000000042", type: "850", group: { id: "PO", control: "42" } });
		expect(p.body.map((s) => s[0])).toEqual(["BEG", "PO1", "CTT"]);
		expect(p.body[1]).toEqual(["PO1", "1", "3", "EA", "9", "", "VP", "BRG-6204"]);
	});

	it("rejects broken envelopes", () => {
		expect(() => parse("hello")).toThrow(EdiError);
		const raw = interchange("000109", "CUSTAPI", 7, "850", [["BEG", "00", "SA", "X"]]);
		expect(() => parse(raw.replace("SE*3*0001", "SE*9*0001"))).toThrow(/SE segment count 9 should be 3/);
		expect(() => parse(raw.replace("IEA*1*000000007", "IEA*1*000000008"))).toThrow(/IEA does not close/);
	});
});

describe("EDI with customers' systems", () => {
	it("turns an 850 into an invoice, acknowledges it, sends an 810 on billing and takes the 820", async () => {
		const bearings = await onHand("BRG-6204");
		const po = await deliver(partnerPO("000109", 101, "4500017", [
			{ sku: "BRG-6204", qty: 50, price: 9 },
			{ sku: "SAF-GLV", qty: 2, price: 52 },
		]));
		expect(po).toMatchObject({ direction: "I", type: "850", partner: "000109", status: "ACCEPTED" });
		const id = po.reference.split(" ")[2];
		expect(po.reference).toBe(`PO 4500017 ${id}`);
		const { invoice, lines } = await getInvoice(db, id);
		expect(invoice).toMatchObject({ customer_id: "000109", status: "O", po_number: "4500017", total: 554, created_by: "EDI" });
		expect(lines.map((l) => [l.sku, l.quantity])).toEqual([["BRG-6204", 50], ["SAF-GLV", 2]]);
		expect(await onHand("BRG-6204")).toBe(bearings - 50);
		expect(await ack(po.id)).toMatch(/AK5\*A~/);

		const billed = await bill(db, "IBMUSER", id);
		expect(billed.edi).toMatchObject({ direction: "O", type: "810", partner: "000109", status: "SENT", reference: id });
		const x810 = parse(billed.edi!.raw);
		expect(x810.body.find((s) => s[0] === "BIG")?.[2]).toBe(id);
		expect(x810.body.filter((s) => s[0] === "IT1")).toHaveLength(2);
		expect(x810.body.find((s) => s[0] === "TDS")?.[1]).toBe("55400");

		const short = await deliver(partnerRemittance("000109", 102, [{ id, total: 500 }]));
		expect(short).toMatchObject({ status: "REJECTED", note: `INVOICE ${id} IS FOR 554, REMITTANCE SAYS 500` });
		expect(await ack(short.id)).toMatch(/AK5\*R\*5~/);

		const paid = await deliver(partnerRemittance("000109", 103, [{ id, total: 554 }]));
		expect(paid).toMatchObject({ status: "ACCEPTED", reference: id });
		expect((await getInvoice(db, id)).invoice.status).toBe("P");

		// It all shows in the customer's event history.
		const events = (await customerEvents(db, "000109")).map((e) => e.event);
		expect(events).toEqual(expect.arrayContaining(["EDI IN", "EDI OUT", "OPENED", "BILLED", "PAYMENT"]));
	});

	it("rejects a whole order when a line cannot be filled, and returns the stock", async () => {
		const gloves = await onHand("SAF-GLV");
		const po = await deliver(partnerPO("000111", 201, "K-77", [
			{ sku: "SAF-GLV", qty: 3, price: 52 },
			{ sku: "XYZ-9999", qty: 1, price: 1 },
		]));
		expect(po).toMatchObject({ status: "REJECTED", note: "PO1 LINE 2: PRODUCT XYZ-9999 IS NOT ON FILE", reference: "PO K-77" });
		expect(await onHand("SAF-GLV")).toBe(gloves);
		expect(await db.prepare("SELECT 1 FROM invoices WHERE po_number = 'K-77'").first()).toBeNull();

		const ok = await deliver(partnerPO("000111", 202, "K-78", [{ sku: "SAF-GLV", qty: 1, price: 52 }]));
		expect(ok.status).toBe("ACCEPTED");
		const dup = await deliver(partnerPO("000111", 203, "K-78", [{ sku: "SAF-GLV", qty: 1, price: 52 }]));
		expect(dup.note).toMatch(/^DUPLICATE PO K-78: ALREADY ON INV\d{5}$/);

		const held = await deliver(partnerPO("000103", 204, "H-1", [{ sku: "SAF-GLV", qty: 1, price: 52 }]));
		expect(held.note).toBe("CUSTOMER IS ON HOLD - NO NEW INVOICES");
	});

	it("rejects what it cannot trace, without acknowledging strangers", async () => {
		const stranger = await deliver(interchange("ACMECORP", "CUSTAPI", 301, "850", [["BEG", "00", "SA", "Z"]]));
		expect(stranger).toMatchObject({ partner: "", status: "REJECTED", note: "SENDER ACMECORP IS NOT A TRADING PARTNER" });
		expect(await ack(stranger.id)).toBe("");

		const wrong = await deliver(interchange("000113", "SOMEONE", 302, "850", [["BEG", "00", "SA", "Z"]]));
		expect(wrong.note).toBe("INTERCHANGE IS ADDRESSED TO SOMEONE, NOT CUSTAPI");
		const asn = await deliver(interchange("000113", "CUSTAPI", 303, "856", [["BSN", "00", "1"]]));
		expect(asn.note).toBe("TRANSACTION SET 856 IS NOT ACCEPTED");
		expect(await ack(asn.id)).toMatch(/AK5\*R/);

		// Processing twice does nothing the second time.
		expect(await processInterchange(db, asn.id)).toBeUndefined();
	});

	it("simulates trading partners ordering and paying", async () => {
		const job = { id: "JOB00900" };
		const orders = await partnersOrder(db, job);
		expect(orders.lines.at(-1)).toMatch(/^3 ORDERS SENT, \d REJECTED$/);
		const accepted = (await listInterchanges(db)).filter((x) => x.type === "850" && x.status === "ACCEPTED" && x.created_by === "EDISIM");
		expect(accepted.length).toBeGreaterThan(0);
		for (const x of accepted) await bill(db, "IBMUSER", x.reference.split(" ")[2]);

		const pay = await partnersPay(db, job);
		expect(pay.lines.some((l) => / PAID INV\d{5}.* ACCEPTED$/.test(l))).toBe(true);
		for (const x of accepted) expect((await getInvoice(db, x.reference.split(" ")[2])).invoice.status).toBe("P");
	});

	it("receives raw X12 over the API", async () => {
		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT(), "Content-Type": "application/edi-x12" };
		const raw = partnerPO("000116", 401, "API-1", [{ sku: "TAP-DUCT", qty: 1, price: 88 }]);
		const res = await worker.fetch("https://api.test/v1/edi", { method: "POST", headers, body: raw });
		expect(res.status).toBe(202);
		const filed = await res.json<{ id: string; status: string; partner: string; type: string }>();
		expect(filed).toMatchObject({ status: "RECEIVED", partner: "000116", type: "850" });
		const one = await worker.fetch(`https://api.test/v1/edi/${filed.id}`, { headers });
		expect((await one.json<{ raw: string }>()).raw).toBe(raw);
		const list = await worker.fetch("https://api.test/v1/edi?partner=000116", { headers });
		expect((await list.json<{ id: string }[]>()).map((x) => x.id)).toContain(filed.id);
		expect((await getInterchange(db, filed.id)).raw).toBe(raw);
		const empty = await worker.fetch("https://api.test/v1/edi", { method: "POST", headers, body: " " });
		expect(empty.status).toBe(422);
	});
});
