import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { addLine, billInvoice, changeLine, createInvoice } from "../src/invoices";
import { binFor, cancelShipment, listShipments, pack, pickTickets, release, ship } from "../src/shipping";

const db = env.DB;

async function refused(fn: () => Promise<unknown>): Promise<HttpError> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof HttpError) return e;
		throw e;
	}
	throw new Error("expected an error");
}

describe("shipping", () => {
	it("picks, packs and ships an invoice, freezing it until cancelled", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000117", "Q-1");
		expect((await refused(() => release(db, "IBMUSER", inv.id))).message).toMatch(/add at least one line/);
		await addLine(db, inv.id, "BLT-0516", 3);
		await addLine(db, inv.id, "TAP-DUCT", 1);

		const s = await release(db, "IBMUSER", inv.id);
		expect(s).toMatchObject({ invoice_id: inv.id, customer_id: "000117", status: "P", created_by: "IBMUSER" });
		expect((await refused(() => release(db, "IBMUSER", inv.id))).message).toBe(`invoice ${inv.id} is already released on ${s.id}`);
		expect((await refused(() => changeLine(db, inv.id, 1, 2))).message).toMatch(/released to the warehouse/);
		expect((await refused(() => ship(db, "IBMUSER", s.id, "UPS"))).message).toMatch(/is picking - it cannot be shipped/);

		// Cancelling puts the invoice back to work.
		await cancelShipment(db, s.id);
		await changeLine(db, inv.id, 1, 2);
		const again = await release(db, "IBMUSER", inv.id);
		expect((await refused(() => pack(db, again.id, 0, 5))).field).toBe("cartons");
		expect(await pack(db, again.id, 1, 12)).toMatchObject({ status: "K", cartons: 1, weight: 12 });
		const { shipment, edi } = await ship(db, "SHIPPER", again.id, "fdx");
		expect(shipment).toMatchObject({ status: "S", carrier: "FDX", shipped_by: "SHIPPER" });
		expect(shipment.tracking).toMatch(/^\d{12}$/);
		expect(edi).toBeUndefined(); // not an EDI order
		expect((await refused(() => cancelShipment(db, again.id))).message).toMatch(/is shipped - it cannot be cancelled/);

		expect((await billInvoice(db, "IBMUSER", inv.id)).invoice.status).toBe("B");
		expect((await listShipments(db, "S")).map((x) => x.id)).toContain(again.id);
	});

	it("prints pick tickets in bin order", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000116");
		await addLine(db, inv.id, "SAF-GLV", 2);
		await addLine(db, inv.id, "BLT-0750", 1);
		await addLine(db, inv.id, "HYD-0250", 1);
		const s = await release(db, "IBMUSER", inv.id);
		const { lines } = await pickTickets(db);
		const at = lines.findIndex((l) => l.startsWith(`PICK TICKET ${s.id}`));
		expect(at).toBeGreaterThanOrEqual(0);
		expect(lines[at + 1]).toBe("  SHIP TO 000116 PIEDMONT TEXTILES");
		const bins = lines.slice(at + 7, at + 10).map((l) => l.trim().split(/\s+/)[0]);
		expect(bins).toEqual([...bins].sort());
		expect(bins).toContain(binFor("SAF-GLV"));
		expect(lines.at(-1)).toMatch(/PICK TICKETS PRINTED$/);
	});
});
