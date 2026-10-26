import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { addLine, billInvoice, changeLine, createInvoice, setAddress } from "../src/invoices";
import { binFor, cancelShipment, listShipments, pack, pickTickets, release, routeFor, ship } from "../src/shipping";

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
		expect((await refused(() => ship(db, "IBMUSER", s.id))).message).toMatch(/is picking - it cannot be shipped/);

		// Cancelling puts the invoice back to work.
		await cancelShipment(db, s.id);
		await changeLine(db, inv.id, 1, 2);
		const again = await release(db, "IBMUSER", inv.id);
		expect((await refused(() => pack(db, again.id, 0, 5))).field).toBe("cartons");
		expect(await pack(db, again.id, 1, 160)).toMatchObject({ status: "K", cartons: 1, weight: 160, carrier: "FDX" });
		const { shipment, edi } = await ship(db, "SHIPPER", again.id);
		expect(shipment).toMatchObject({ status: "S", carrier: "FDX", shipped_by: "SHIPPER", route: "160 LB IS 150 LB OR MORE" });
		expect(shipment.tracking).toMatch(/^\d{12}$/);
		expect(edi).toBeUndefined(); // not an EDI order
		expect((await refused(() => cancelShipment(db, again.id))).message).toMatch(/is shipped - it cannot be cancelled/);

		expect((await billInvoice(db, "IBMUSER", inv.id)).invoice.status).toBe("B");
		expect((await listShipments(db, "S")).map((x) => x.id)).toContain(again.id);
	});

	it("chooses the carrier from the ship-to, weight and value", () => {
		expect(routeFor({ state: "PA" }, 40, 4000, 90000)).toEqual({ carrier: "TRK", reason: "PA IS IN THE TRUCK AREA" });
		expect(routeFor({ state: "TX" }, 3, 150, 100)).toEqual({ carrier: "FDX", reason: "150 LB IS 150 LB OR MORE" });
		expect(routeFor({ state: "TX" }, 1, 71, 100)).toEqual({ carrier: "FDX", reason: "CARTONS OVER 70 LB" });
		expect(routeFor({ state: "TX" }, 2, 140, 100).carrier).toBe("UPS");
		expect(routeFor({ state: "TX" }, 1, 5, 5000)).toEqual({ carrier: "FDX", reason: "VALUE $5000 NEEDS FULL COVER" });
		expect(routeFor({ state: "OR" }, 1, 5, 4999)).toEqual({ carrier: "UPS", reason: "5 LB TO OR, OUTSIDE THE TRUCK AREA" });
	});

	it("routes by the invoice's ship-to, not the customer's address", async () => {
		const inv = await createInvoice(db, "IBMUSER", "000117");
		await addLine(db, inv.id, "TAP-DUCT", 1);
		await setAddress(db, inv.id, "ship", { name: "OHIO SITE", address: "", city: "AKRON", state: "OH", zip: "44308" });
		const s = await release(db, "IBMUSER", inv.id);
		expect(await pack(db, s.id, 1, 5)).toMatchObject({ carrier: "TRK", route: "OH IS IN THE TRUCK AREA" });
		expect((await ship(db, "IBMUSER", s.id)).shipment.tracking).toMatch(/^PRO/);
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
