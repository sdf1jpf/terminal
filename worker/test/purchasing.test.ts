import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processInterchange, receive } from "../src/edi";
import { getPO, reorder, vendorConfirmation, vendorsConfirm, vendorsShip, vendorShipNotice } from "../src/purchasing";
import { accessJWT } from "./access";

const db = env.DB;
const worker = (exports as unknown as { default: Fetcher }).default;

async function call(method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await worker.fetch(`https://api.test${path}`, {
		method, headers, body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: res.status === 204 ? undefined : await res.json<any>() };
}

const onHand = async (sku: string) =>
	(await db.prepare("SELECT on_hand FROM products WHERE sku = ?").bind(sku).first<{ on_hand: number }>())!.on_hand;

const job = { id: "JOB00042", name: "CUSREORD" };

describe("vendors", () => {
	it("lists the vendors and who supplies each product", async () => {
		const { body } = await call("GET", "/v1/vendors");
		expect(body.map((v: { id: string }) => v.id)).toEqual(["V00001", "V00002", "V00003", "V00004"]);
		expect(body[1]).toMatchObject({ name: "GREAT LAKES BEARING CO", lead_days: 5, products: 4 });
		const brg = await call("GET", "/v1/products/BRG-6204");
		expect(brg.body).toMatchObject({ vendor: "V00002", unit_cost: 6 });
		expect((await call("GET", "/v1/vendors/V09999")).status).toBe(404);
	});

	it("refuses a product vendor that is not on file", async () => {
		const p = (await call("GET", "/v1/products/TAP-DUCT")).body;
		const res = await call("PUT", "/v1/products/TAP-DUCT", { ...p, vendor: "V00099" });
		expect(res.status).toBe(422);
		expect(res.body.error.field).toBe("vendor");
	});
});

describe("purchase orders", () => {
	it("builds a PO, sends it as an 850 and receives it into stock", async () => {
		const open = await call("POST", "/v1/purchase-orders", { vendor_id: "v00002" });
		expect(open.status).toBe(201);
		const id = open.body.id;
		expect(open.body).toMatchObject({ vendor_id: "V00002", status: "O", created_by: "IBMUSER" });

		const line = await call("POST", `/v1/purchase-orders/${id}/lines`, { sku: "brg-6204", quantity: 100 });
		expect(line.body).toMatchObject({ line: 1, sku: "BRG-6204", quantity: 100, unit_cost: 6, received: 0 });
		await call("POST", `/v1/purchase-orders/${id}/lines`, { sku: "CHN-0080", quantity: 4 });
		const wrong = await call("POST", `/v1/purchase-orders/${id}/lines`, { sku: "BLT-0516", quantity: 1 });
		expect(wrong.status).toBe(422);
		expect(wrong.body.error.message).toBe("BLT-0516 is supplied by V00001, not V00002");
		expect((await call("POST", `/v1/purchase-orders/${id}/receive`, {})).status).toBe(422);

		const sent = await call("POST", `/v1/purchase-orders/${id}/send`);
		expect(sent.body.po).toMatchObject({ status: "S", total: 600 + 4 * 68 });
		expect(sent.body.edi).toMatchObject({ direction: "O", type: "850", partner: "V00002", status: "SENT", reference: id });
		expect(sent.body.edi.raw).toContain(`BEG*00*NE*${id}*`);
		expect(sent.body.edi.raw).toContain("PO1*1*100*EA*6**VP*BRG-6204~");
		expect((await call("POST", `/v1/purchase-orders/${id}/lines`, { sku: "BRG-6310", quantity: 1 })).status).toBe(422);

		const bearings = await onHand("BRG-6204");
		const over = await call("POST", `/v1/purchase-orders/${id}/receive`, { lines: { "1": 101 } });
		expect(over.status).toBe(422);
		expect(over.body.error.field).toBe("rcv:1");
		const part = await call("POST", `/v1/purchase-orders/${id}/receive`, { lines: { "1": 40 } });
		expect(part.body).toMatchObject({ po: { status: "S" }, units: 40 });
		expect(await onHand("BRG-6204")).toBe(bearings + 40);

		const rest = await call("POST", `/v1/purchase-orders/${id}/receive`, {});
		expect(rest.body).toMatchObject({ po: { status: "R" }, units: 64 });
		expect(await onHand("BRG-6204")).toBe(bearings + 100);
		const { lines } = await getPO(db, id);
		expect(lines.map((l) => l.received)).toEqual([100, 4]);
		const { results } = await db.prepare("SELECT sku, quantity, unit_cost FROM receipts WHERE po_id = ? ORDER BY seq").bind(id).all();
		expect(results).toEqual([
			{ sku: "BRG-6204", quantity: 40, unit_cost: 6 },
			{ sku: "BRG-6204", quantity: 60, unit_cost: 6 },
			{ sku: "CHN-0080", quantity: 4, unit_cost: 68 },
		]);
	});

	it("cancels an open PO and refuses inactive or unknown vendors", async () => {
		const { body } = await call("POST", "/v1/purchase-orders", { vendor_id: "V00004" });
		expect((await call("DELETE", `/v1/purchase-orders/${body.id}`)).status).toBe(204);
		expect((await call("GET", `/v1/purchase-orders/${body.id}`)).status).toBe(404);
		const bad = await call("POST", "/v1/purchase-orders", { vendor_id: "V00077" });
		expect(bad.status).toBe(422);
		expect(bad.body.error.field).toBe("vendor");
	});
});

describe("reordering and the vendors' systems", () => {
	it("orders low stock once per vendor, then the vendors confirm and ship by EDI", async () => {
		const first = await reorder(db, job);
		const pos = first.lines.filter((l) => / PO\d{5}$/.test(l));
		expect(pos.find((l) => l.startsWith("GRS-EP2"))).toMatch(/ +8 +20 +0 +32 PO\d{5}$/);
		expect(pos.find((l) => l.startsWith("VLV-0100"))).toMatch(/ +0 +25 +0 +50 PO\d{5}$/);
		expect(first.lines.at(-1)).toMatch(/PURCHASE ORDERS SENT$/);
		const ids = [...new Set(pos.map((l) => l.slice(-7)))];

		// A second run finds everything on order.
		const again = await reorder(db, job);
		expect(again.lines.at(-1)).toMatch(/, 0 PURCHASE ORDERS SENT$/);
		expect(again.lines.find((l) => l.startsWith("GRS-EP2"))).toMatch(/ON ORDER$/);

		const confirmed = await vendorsConfirm(db, { id: "JOB00043" });
		expect(confirmed.lines.filter((l) => l.includes("ACCEPTED")).length).toBeGreaterThanOrEqual(ids.length);
		const { po } = await getPO(db, ids[0]);
		expect(po.status).toBe("A");
		expect(po.ship_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		await vendorsShip(db, { id: "JOB00043" });
		expect((await getPO(db, ids[0])).po.status).toBe("T");

		// An 856 for an order that is already in transit is rejected with a 997.
		const dup = await receive(db, "TEST", vendorShipNotice(po.vendor_id, 991, ids[0]));
		const done = (await processInterchange(db, dup.id))!;
		expect(done).toMatchObject({ status: "REJECTED", partner: po.vendor_id, reference: ids[0] });
		expect(done.note).toMatch(/IS IN TRANSIT, NOT AWAITING SHIPMENT/);
		const ack = await db.prepare("SELECT raw FROM edi WHERE type = '997' AND reference = ?").bind(`${dup.id} REJECTED`).first<{ raw: string }>();
		expect(ack?.raw).toContain("AK5*R*5");
	});

	it("rejects vendor documents for someone else's order", async () => {
		const { body } = await call("POST", "/v1/purchase-orders", { vendor_id: "V00001" });
		await call("POST", `/v1/purchase-orders/${body.id}/lines`, { sku: "SAF-GLV", quantity: 3 });
		await call("POST", `/v1/purchase-orders/${body.id}/send`);
		const filed = await receive(db, "TEST", vendorConfirmation("V00003", 992, body.id, new Date()));
		const done = (await processInterchange(db, filed.id))!;
		expect(done.status).toBe("REJECTED");
		expect(done.note).toBe(`PURCHASE ORDER ${body.id} WAS NOT SENT TO V00003`);
		expect((await getPO(db, body.id)).po.status).toBe("S");
	});
});
