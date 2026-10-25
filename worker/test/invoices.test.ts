import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	addLine, billInvoice, cancelInvoice, changeLine, createInvoice, deleteLine, getInvoice, listInvoices, payInvoice, setPO,
} from "../src/invoices";
import { HttpError } from "../src/http";
import { accessJWT } from "./access";
import { shipInvoice } from "./ship";

const db = env.DB;

const onHand = async (sku: string) =>
	(await db.prepare("SELECT on_hand FROM products WHERE sku = ?").bind(sku).first<{ on_hand: number }>())!.on_hand;
const balance = async (id: string) =>
	(await db.prepare("SELECT balance FROM customers WHERE id = ?").bind(id).first<{ balance: number }>())!.balance;

// refused runs fn and returns the HttpError it threw.
async function refused(fn: () => Promise<unknown>): Promise<HttpError> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof HttpError) return e;
		throw e;
	}
	throw new Error("expected an error");
}

describe("invoices", () => {
	it("builds an invoice from stock, bills it and marks it paid", async () => {
		const bearings = await onHand("BRG-6204");
		const before = await balance("000104");
		const inv = await createInvoice(db, "IBMUSER", "000104", "po-4471");
		expect(inv).toMatchObject({ id: expect.stringMatching(/^INV\d{5}$/), status: "O", po_number: "PO-4471", total: 0 });

		const l1 = await addLine(db, inv.id, "brg-6204", 100);
		expect(l1).toMatchObject({ line: 1, sku: "BRG-6204", description: "BALL BEARING 6204-2RS", quantity: 100, unit_price: 9 });
		await addLine(db, inv.id, "PMP-0150", 2);
		expect(await onHand("BRG-6204")).toBe(bearings - 100);
		expect(await onHand("PMP-0150")).toBe(1);

		await changeLine(db, inv.id, 1, 40);
		expect(await onHand("BRG-6204")).toBe(bearings - 40);
		await changeLine(db, inv.id, 1, 50);
		expect(await onHand("BRG-6204")).toBe(bearings - 50);
		await deleteLine(db, inv.id, 2);
		expect(await onHand("PMP-0150")).toBe(3);
		await setPO(db, inv.id, "po-4472");

		let { invoice, lines } = await getInvoice(db, inv.id);
		expect(invoice).toMatchObject({ total: 450, po_number: "PO-4472" });
		expect(lines.map((l) => l.line)).toEqual([1]);

		expect((await refused(() => billInvoice(db, "IBMUSER", inv.id))).message).toMatch(/has not shipped - release it to the warehouse first/);
		await shipInvoice(db, inv.id);
		const billed = await billInvoice(db, "IBMUSER", inv.id);
		expect(billed.invoice.status).toBe("B");
		expect(billed.transaction).toMatchObject({ type: "I", amount: 450, reference: inv.id, balance: before + 450 });
		expect(await balance("000104")).toBe(before + 450);

		// A billed invoice is frozen.
		expect((await refused(() => addLine(db, inv.id, "BRG-6204", 1))).message).toMatch(/is billed/);
		expect((await refused(() => changeLine(db, inv.id, 1, 1))).message).toMatch(/is billed/);
		expect((await refused(() => cancelInvoice(db, inv.id))).message).toMatch(/is billed/);
		expect((await refused(() => billInvoice(db, "IBMUSER", inv.id))).message).toMatch(/already billed/);

		const paid = await payInvoice(db, "IBMUSER", inv.id);
		expect(paid.transaction).toMatchObject({ type: "P", amount: 450, balance: before });
		expect(await balance("000104")).toBe(before);
		expect((await refused(() => payInvoice(db, "IBMUSER", inv.id))).message).toMatch(/already paid/);
		({ invoice } = await getInvoice(db, inv.id));
		expect(invoice.status).toBe("P");
		expect(invoice.paid).not.toBe("");

		expect((await listInvoices(db, "000104")).map((i) => i.id)).toContain(inv.id);
		expect(await listInvoices(db, "000105")).toEqual([]);
	});

	it("refuses what cannot be sold", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000105");
		let e = await refused(() => addLine(db, inv.id, "PMP-0150", 4));
		expect(e).toMatchObject({ status: 422, field: "qty", message: "only 3 of PMP-0150 on hand" });
		e = await refused(() => addLine(db, inv.id, "WLD-7018", 1));
		expect(e).toMatchObject({ field: "sku", message: "product WLD-7018 is discontinued" });
		e = await refused(() => addLine(db, inv.id, "NOPE", 1));
		expect(e).toMatchObject({ field: "sku", message: "product NOPE is not on file" });
		e = await refused(() => addLine(db, inv.id, "BRG-6204", 0));
		expect(e.field).toBe("qty");
		e = await refused(() => billInvoice(db, "IBMUSER", inv.id));
		expect(e.message).toBe("add at least one line before billing");
		e = await refused(() => payInvoice(db, "IBMUSER", inv.id));
		expect(e.message).toMatch(/must be billed/);

		await addLine(db, inv.id, "PMP-0150", 1);
		e = await refused(() => changeLine(db, inv.id, 1, 5));
		expect(e).toMatchObject({ field: "qty", message: "only 2 more of PMP-0150 on hand" });
		expect(await onHand("PMP-0150")).toBe(2);

		e = await refused(() => createInvoice(db, "IBMUSER", "000103"));
		expect(e).toMatchObject({ field: "id", message: "customer is on hold - no new invoices" });
		e = await refused(() => createInvoice(db, "IBMUSER", "999999"));
		expect(e.status).toBe(404);
	});

	it("cancels an open invoice and returns its stock", async () => {
		const tape = await onHand("TAP-DUCT");
		const inv = await createInvoice(db, "IBMUSER", "000107");
		await addLine(db, inv.id, "TAP-DUCT", 5);
		await addLine(db, inv.id, "TAP-DUCT", 7);
		expect(await onHand("TAP-DUCT")).toBe(tape - 12);
		await cancelInvoice(db, inv.id);
		expect(await onHand("TAP-DUCT")).toBe(tape);
		expect((await refused(() => getInvoice(db, inv.id))).status).toBe(404);
	});
});

describe("invoices API", () => {
	const worker = (exports as unknown as { default: Fetcher }).default;
	async function call(method: string, path: string, body?: unknown) {
		const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await accessJWT() };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await worker.fetch(`https://api.test${path}`, {
			method, headers, body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
	}

	it("builds, bills and pays an invoice over REST", async () => {
		const open = await call("POST", "/v1/invoices", { customer_id: "000113", po_number: "rest-1" });
		expect(open.status).toBe(201);
		const id = open.body.id;
		expect((await call("POST", `/v1/invoices/${id}/lines`, { sku: "hyd-0250", quantity: 2 })).status).toBe(201);
		expect((await call("POST", `/v1/invoices/${id}/lines`, { sku: "plt-4848", quantity: 1 })).status).toBe(201);
		expect((await call("PUT", `/v1/invoices/${id}/lines/1`, { quantity: 3 })).body.quantity).toBe(3);
		expect((await call("DELETE", `/v1/invoices/${id}/lines/2`)).status).toBe(204);
		expect((await call("PUT", `/v1/invoices/${id}`, { po_number: "rest-2" })).body.po_number).toBe("REST-2");
		const short = await call("POST", `/v1/invoices/${id}/lines`, { sku: "vlv-0100", quantity: 1 });
		expect(short).toMatchObject({ status: 422, body: { error: { field: "qty" } } });

		const got = await call("GET", `/v1/invoices/${id}`);
		expect(got.body.lines).toHaveLength(1);
		const shp = await call("POST", "/v1/shipments", { invoice_id: id });
		expect(shp.status).toBe(201);
		expect((await call("PUT", `/v1/invoices/${id}/lines/1`, { quantity: 2 })).body.error.message).toMatch(/released to the warehouse/);
		expect((await call("POST", `/v1/shipments/${shp.body.id}/pack`, { cartons: 2, weight: 80 })).body.status).toBe("K");
		expect((await call("POST", `/v1/shipments/${shp.body.id}/ship`, { carrier: "ups" })).body.shipment.status).toBe("S");
		expect((await call("POST", `/v1/invoices/${id}/bill`)).body.invoice.status).toBe("B");
		expect((await call("PUT", `/v1/invoices/${id}/lines/1`, { quantity: 1 })).status).toBe(422);
		expect((await call("POST", `/v1/invoices/${id}/pay`)).body.transaction.type).toBe("P");
		expect((await call("GET", "/v1/invoices?customer=000113")).body.map((i: { id: string }) => i.id)).toContain(id);
		expect((await call("GET", `/v1/invoices/${id}/lines/x`)).status).toBe(405);
		expect((await call("DELETE", `/v1/invoices/${id}/lines/x`)).status).toBe(404);
		expect((await call("PATCH", `/v1/invoices/${id}`)).status).toBe(405);
	});
});
