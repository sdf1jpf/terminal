import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { addLine, createInvoice } from "../src/invoices";
import { lookAtInvoice, timeline } from "../src/lifecycle";
import { pack, release, ship, type Shipment } from "../src/shipping";
import {
	confirmDelivery, findShipment, getTracking, pollTracking, registerProvider, simulated, simulatedTrip, trackShipment, trackingEvents,
	type TrackingProvider,
} from "../src/tracking";
import { Terminal } from "./term";

const db = env.DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function shipped(customer: string, weight = 10): Promise<Shipment> {
	const inv = await createInvoice(db, "IBMUSER", customer, "TRACK-1");
	await addLine(db, inv.id, "BLT-0516", 2);
	const s = await release(db, "IBMUSER", inv.id);
	await pack(db, env.TABLES, s.id, 1, weight);
	return (await ship(db, "SHIPPER", s.id)).shipment;
}

const screenText = (t: Terminal) => Array.from({ length: t.scr.rows }, (_, i) => t.row(i + 1)).join("\n");

const get = async (id: string) => (await db.prepare("SELECT * FROM shipments WHERE id = ?").bind(id).first<Shipment>())!;

describe("tracking", () => {
	it("plays out the same trip for a tracking number every time", () => {
		const req = { shipment: "SHP99999", carrier: "UPS", tracking: "1Z123E00001", shipped: "2026-10-26T15:00:00.000Z", shipTo: { name: "X", address: "", city: "BARRE", state: "VT", zip: "" }, transitDays: 4 };
		const trip = simulatedTrip(req);
		expect(simulatedTrip(req)).toEqual(trip);
		expect(trip.scans[0]).toMatchObject({ code: "LABEL", at: req.shipped, location: "COLUMBUS, OH" });
		expect(trip.scans.map((s) => s.code)).toContain("ARRIVE");
		expect(trip.scans.some((s) => s.location === "LOUISVILLE, KY")).toBe(true);
		expect(trip.scans.at(-1)).toMatchObject({ code: "DELIVERED", location: "BARRE, VT" });
		expect(trip.promised).toBe("2026-10-30");
		const times = trip.scans.map((s) => s.at);
		expect([...times].sort()).toEqual(times);
		// Some trips are held up a day on the last leg.
		const held = Array.from({ length: 60 }, (_, i) => simulatedTrip({ ...req, tracking: `1Z${i}` })).filter((t) => t.eta !== t.promised);
		expect(held.length).toBeGreaterThan(0);
		for (const t of held) expect(t.scans.map((s) => s.code)).toContain("EXCEPTION");
	});

	it("follows a shipment from the label to the signature", async () => {
		const s = await shipped("000117");
		expect(s.delivery).toBe("T");
		const at = Date.parse(s.shipped);

		let x = await trackShipment(db, env.TABLES, s, at + 2 * HOUR);
		expect(x).toMatchObject({ delivery: "T" });
		expect(x.eta).toBe(new Date(Math.floor(at / DAY) * DAY + 4 * DAY).toISOString().slice(0, 10)); // UPS: 4 days
		expect((await trackingEvents(db, s.id)).map((e) => e.code)).toEqual(["PICKUP", "LABEL"]);

		x = await trackShipment(db, env.TABLES, x, at + 10 * DAY);
		expect(x).toMatchObject({ delivery: "D" });
		expect(x.signed_by).not.toBe("");
		const events = await trackingEvents(db, s.id);
		expect(events[0]).toMatchObject({ code: "DELIVERED", location: "BARRE, VT" });
		// Asking again adds nothing.
		await trackShipment(db, env.TABLES, await get(s.id), at + 11 * DAY);
		expect(await trackingEvents(db, s.id)).toHaveLength(events.length);

		// The delivery woke the lifecycle, which put it on the timeline.
		const { results: signals } = await db.prepare("SELECT what FROM order_signals WHERE ref = ?").bind(s.invoice_id).all<{ what: string }>();
		expect(signals.map((r) => r.what)).toContain("DELIVERED");
		await lookAtInvoice(db, s.invoice_id);
		const tl = await timeline(db, "I", s.invoice_id);
		expect(tl.map((e) => e.event)).toEqual(expect.arrayContaining(["SHIPPED", "OUT FOR DLVY", "DELIVERED"]));
		expect(tl.find((e) => e.event === "DELIVERED")!.detail).toBe(`SIGNED BY ${x.signed_by}`);
	});

	it("polls the shipments on their way, each at most every half hour", async () => {
		const s = await shipped("000101");
		const now = Date.parse(s.shipped) + 3 * HOUR;
		expect(await pollTracking(db, env.TABLES, now, 500)).toBeGreaterThan(0);
		expect((await get(s.id)).tracked).toBe(new Date(now).toISOString());
		await pollTracking(db, env.TABLES, now + 10 * 60_000, 500);
		expect((await get(s.id)).tracked).toBe(new Date(now).toISOString());
		await pollTracking(db, env.TABLES, now + 31 * 60_000, 500);
		expect((await get(s.id)).tracked).toBe(new Date(now + 31 * 60_000).toISOString());
	});

	it("uses a carrier's own provider once one is registered", async () => {
		const s = await shipped("000117", 160); // FDX
		const fake: TrackingProvider = {
			name: "FAKE",
			async track() {
				return { delivery: "X", eta: "2099-01-01", scans: [{ at: "2026-10-26T20:00:00.000Z", code: "EXCEPTION", location: "MEMPHIS, TN", detail: "ADDRESS CORRECTION" }] };
			},
		};
		registerProvider("FDX", fake);
		try {
			const { shipment, events } = await getTracking(db, env.TABLES, s.id, true);
			expect(shipment).toMatchObject({ delivery: "X", eta: "2099-01-01" });
			expect(events.map((e) => e.detail)).toEqual(["ADDRESS CORRECTION"]);
			const log = await db.prepare("SELECT text FROM syslog WHERE text LIKE ? ").bind(`CUS1701W ${s.id}%`).first<{ text: string }>();
			expect(log?.text).toContain("ADDRESS CORRECTION");
		} finally {
			registerProvider("FDX", simulated);
		}
	});

	it("signs off a company truck delivery by hand", async () => {
		const s = await shipped("000111"); // PA: company truck? only for freight - UPS takes 10 lb
		expect(s.carrier).toBe("UPS");
		const refused = await confirmDelivery(db, "IBMUSER", s.id, "SMITH").catch((e: HttpError) => e);
		expect((refused as HttpError).message).toMatch(/UPS reports its own deliveries/);

		const truck = await shipped("000111", 400);
		expect(truck.carrier).toBe("TRK");
		expect(((await confirmDelivery(db, "IBMUSER", truck.id, " ").catch((e: HttpError) => e)) as HttpError).field).toBe("signed");
		const x = await confirmDelivery(db, "DRIVER", truck.id, "kowalski");
		expect(x).toMatchObject({ delivery: "D", signed_by: "KOWALSKI" });
		expect((await trackingEvents(db, truck.id))[0].detail).toBe("DELIVERED, SIGNED BY KOWALSKI - ENTERED BY DRIVER");
		expect(((await confirmDelivery(db, "IBMUSER", truck.id, "X").catch((e: HttpError) => e)) as HttpError).message).toMatch(/already delivered/);
	});

	it("finds a shipment by its number, invoice or tracking number", async () => {
		const s = await shipped("000117");
		expect((await findShipment(db, s.id))?.id).toBe(s.id);
		expect((await findShipment(db, String(Number(s.id.slice(3)))))?.id).toBe(s.id);
		expect((await findShipment(db, s.invoice_id.toLowerCase()))?.id).toBe(s.id);
		expect((await findShipment(db, s.tracking))?.id).toBe(s.id);
		expect(await findShipment(db, "NOPE")).toBeUndefined();
	});

	it("shows where a shipment is on CUSS03", async () => {
		const s = await shipped("000117");
		const t = await Terminal.logon();
		await t.fill("option", "2.6 " + s.id).send("ENTER");
		expect(t.scr.map).toBe("CUSS03");
		expect(screenText(t)).toContain(s.id);
		expect(screenText(t)).toContain("UPS GROUND");
		expect(screenText(t)).toMatch(/IN TRANSIT +PROMISED \d{4}-\d\d-\d\d/);
		expect(screenText(t)).toContain("SHIPPING LABEL CREATED");
		await t.send("PF5");
		expect(t.message).toBe(`CUS0822I UPS SAYS ${s.id} IS IN TRANSIT`);
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSS02");
		expect(screenText(t)).toContain("IN TRANSIT");
		await t.send("PF5");
		expect(t.scr.map).toBe("CUSS03");
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSL01");
		await t.send("PF3");
		await t.fill("id", s.tracking).send("ENTER");
		expect(screenText(t)).toContain(s.invoice_id);
		await t.send("PF3");
		await t.fill("option", "TRACK " + s.invoice_id).send("ENTER");
		expect(t.scr.map).toBe("CUSS03");
		expect(t.field("id")?.value).toBe(s.id);
		await t.fill("id", "NOSUCH").send("ENTER");
		expect(t.message).toBe("CUS0821E NO SHIPMENT FOR NOSUCH");

		const truck = await shipped("000111", 400);
		await t.fill("id", truck.id).send("ENTER");
		expect(t.row(11)).toMatch(/TRUCK DELIVERED, SIGNED BY ===> +THEN PF10/);
		expect(t.scr.cursor).toEqual({ field: "signed" });
		await t.send("PF10");
		expect(t.message).toBe("CUS0825E ENTER WHO SIGNED FOR IT");
		await t.fill("signed", "dock 4").send("PF10");
		expect(t.message).toBe(`CUS0824I ${truck.id} DELIVERED, SIGNED BY DOCK 4`);
		expect(t.row(9)).toMatch(/DELIVERED .* SIGNED BY DOCK 4/);
		expect(t.field("signed")).toBeUndefined();
	});

	it("answers on the REST API", async () => {
		const s = await shipped("000117");
		const { accessJWT } = await import("./access");
		const { worker } = await import("./term");
		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT(), "Content-Type": "application/json" };
		let res = await worker.fetch(`https://api.test/v1/track/${s.tracking}`, { headers });
		expect(res.status).toBe(200);
		const body = await res.json<{ shipment: Shipment; events: unknown[] }>();
		expect(body.shipment.id).toBe(s.id);
		expect(body.events.length).toBeGreaterThan(0);
		res = await worker.fetch(`https://api.test/v1/shipments/${s.id}/tracking`, { method: "POST", headers });
		expect(res.status).toBe(200);
		res = await worker.fetch(`https://api.test/v1/shipments/${s.id}/delivered`, { method: "POST", headers, body: JSON.stringify({ signed_by: "X" }) });
		expect(res.status).toBe(422);
		res = await worker.fetch(`https://api.test/v1/shipments/${s.id}/tracking`, { method: "DELETE", headers });
		expect(res.status).toBe(405);
	});
});
