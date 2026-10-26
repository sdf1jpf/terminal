import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	assignLoad, board, cancelLoad, dispatchLoad, dutyMinutes, freightDay, getLoad, getTruck, group, listLoads, planLoads, returnLoad, schedule,
	sequence, serviceState, truckServiced, waitingShipments, type Driver, type Truck, type Waiting,
} from "../src/fleet";
import { bearing, DEPOT, locate, miles } from "../src/geo";
import { HttpError } from "../src/http";
import { addLine, createInvoice } from "../src/invoices";
import { pack, release, ship, type Shipment } from "../src/shipping";
import { confirmDelivery, trackingEvents } from "../src/tracking";
import { Terminal } from "./term";

const db = env.DB;

// packed makes a packed shipment for a customer; 150 lb or more to OH IN KY
// MI PA WV goes on the company truck.
async function packed(customer: string, weight = 400): Promise<Shipment> {
	const inv = await createInvoice(db, "IBMUSER", customer, "FREIGHT-1");
	await addLine(db, inv.id, "PLT-4848", 1);
	const s = await release(db, "IBMUSER", inv.id);
	return pack(db, env.TABLES, s.id, 2, weight);
}

const err = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as HttpError;
const screenText = (t: Terminal) => Array.from({ length: t.scr.rows }, (_, i) => t.row(i + 1)).join("\n");

let trucks: Truck[];
let drivers: Driver[];

beforeAll(async () => {
	trucks = (await db.prepare("SELECT * FROM trucks").all<Truck>()).results;
	drivers = (await db.prepare("SELECT * FROM drivers").all<Driver>()).results;
});

// Each test starts with no loads, nothing waiting for the truck and the
// fleet as it was.
beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM load_stops"),
		db.prepare("DELETE FROM loads"),
		db.prepare("UPDATE shipments SET status = 'S', delivery = 'D' WHERE carrier = 'TRK' AND status = 'K'"),
		...trucks.map((t) => db.prepare("UPDATE trucks SET odometer = ?, status = ?, service_miles = ?, service_due = ? WHERE id = ?")
			.bind(t.odometer, t.status, t.service_miles, t.service_due, t.id)),
		...drivers.map((d) => db.prepare("UPDATE drivers SET status = ?, cdl_expires = ? WHERE id = ?").bind(d.status, d.cdl_expires, d.id)),
	]);
});

describe("routes", () => {
	it("knows where the truck's cities are", () => {
		expect(miles(DEPOT, locate("DAYTON", "OH"))).toBeGreaterThan(60);
		expect(miles(DEPOT, locate("DAYTON", "OH"))).toBeLessThan(100);
		expect(locate("NOWHERE", "PA")).toEqual(locate("nowhere", "pa"));
		expect(locate("NOWHERE", "PA")).not.toEqual(locate("ELSEWHERE", "PA"));
		const north = bearing(DEPOT, locate("DETROIT", "MI"));
		expect(Math.min(north, 360 - north)).toBeLessThan(10);
	});

	it("orders stops to drive the fewest miles", () => {
		const stops = ["PITTSBURGH,PA", "DAYTON,OH", "WHEELING,WV", "CINCINNATI,OH"].map((c) => {
			const [city, st] = c.split(",");
			return { city, ...locate(city, st) };
		});
		const route = sequence(stops);
		expect(route.map((s) => s.city)).toHaveLength(4);
		const total = (r: typeof stops) => schedule(r).miles;
		expect(total(route)).toBeLessThanOrEqual(total(stops));
		// East and west are not mixed: the two Ohio cities west of the
		// warehouse are next to each other.
		const i = route.findIndex((s) => s.city === "DAYTON");
		const j = route.findIndex((s) => s.city === "CINCINNATI");
		expect(Math.abs(i - j)).toBe(1);
		const p = schedule(route);
		expect(p.eta[0]).toBeGreaterThan(0);
		expect(p.duty_min).toBe(30 + p.drive_min + 30 * 4);
	});

	it("groups shipments by direction and weight", () => {
		const w = (id: string, city: string, st: string, weight: number): Waiting => {
			const p = locate(city, st);
			return { shipment_id: id, invoice_id: "", customer_id: "", name: "", city, state: st, cartons: 1, weight, ...p, bearing: bearing(DEPOT, p) };
		};
		const { loads, tooHeavy } = group([
			w("A", "DETROIT", "MI", 3000), w("B", "TOLEDO", "OH", 3000), w("C", "CINCINNATI", "OH", 3000),
			w("D", "DAYTON", "OH", 3000), w("E", "PITTSBURGH", "PA", 3000), w("F", "GARY", "IN", 60000),
		], 10000);
		expect(tooHeavy.map((x) => x.shipment_id)).toEqual(["F"]);
		for (const l of loads) expect(l.reduce((t, x) => t + x.weight, 0)).toBeLessThanOrEqual(10000);
		const together = (a: string, b: string) => loads.some((l) => l.some((x) => x.shipment_id === a) && l.some((x) => x.shipment_id === b));
		expect(together("A", "B")).toBe(true); // north
		expect(together("C", "D")).toBe(true); // southwest
		expect(together("A", "C")).toBe(false);
	});
});

describe("fleet", () => {
	it("knows when a truck is due for service", async () => {
		const t = await getTruck(db, "T01");
		expect(serviceState(t, "2026-10-26")).toBe("OK");
		expect(serviceState({ ...t, odometer: t.service_miles - 100 }, "2026-10-26")).toBe("SOON");
		expect(serviceState({ ...t, odometer: t.service_miles }, "2026-10-26")).toBe("DUE");
		expect(serviceState(t, t.service_due)).toBe("DUE");
		const s = await truckServiced(db, "MECHANIC", "T04");
		expect(s).toMatchObject({ status: "A", service_miles: s.odometer + 15000 });
		expect(serviceState(s)).toBe("OK");
	});

	it("plans the day's truck shipments into loads", async () => {
		const day = freightDay();
		const dayton = await packed("000101", 900); // OH
		const gary = await packed("000109", 2000); // IN
		const bethlehem = await packed("000111", 600); // PA
		const norristown = await packed("000122", 700); // PA
		const heavy = await packed("000101", 50000);
		const ups = await packed("000101", 20);
		expect([dayton, gary, bethlehem, norristown, heavy].map((s) => s.carrier)).toEqual(["TRK", "TRK", "TRK", "TRK", "TRK"]);
		expect(ups.carrier).toBe("UPS");
		expect((await waitingShipments(db)).map((w) => w.shipment_id).sort()).toEqual([dayton, gary, bethlehem, norristown, heavy].map((s) => s.id).sort());

		const { loads, unplanned } = await planLoads(db, "DISPATCH", day);
		expect(unplanned).toEqual([{ shipment_id: heavy.id, reason: "50000 LB - OVER EVERY TRUCK" }]);
		expect(loads.length).toBeGreaterThan(0);
		const planned = await listLoads(db, day);
		const ids = (await Promise.all(planned.map((l) => getLoad(db, l.id)))).flatMap((g) => g.stops.map((s) => s.shipment_id));
		expect(ids.sort()).toEqual([dayton, gary, bethlehem, norristown].map((s) => s.id).sort());
		for (const l of planned) {
			const { truck, driver, stops } = await getLoad(db, l.id);
			expect(truck.id).not.toBe("T04"); // in the shop
			expect(driver.id).not.toBe("D04"); // off
			expect(l.weight).toBeLessThanOrEqual(truck.capacity_lb);
			expect(driver.cdl_class <= truck.cdl_class).toBe(true);
			expect(stops.map((s) => s.seq)).toEqual(stops.map((_, i) => i + 1));
			expect(l.status).toBe("P");
		}
		// The two Pennsylvania stops ride together.
		const pa = planned.find((l) => l.region.includes("PA"))!;
		expect(pa.stops).toBe(2);
		// Planning again plans nothing new; the heavy one still waits.
		expect((await planLoads(db, "DISPATCH", day)).loads).toEqual([]);
		expect((await waitingShipments(db)).map((w) => w.shipment_id)).toEqual([heavy.id]);
		// A past day cannot be planned.
		expect((await err(planLoads(db, "DISPATCH", "2020-01-01"))).field).toBe("day");
	});

	it("leaves out trucks due for service and drivers without hours", async () => {
		const day = freightDay();
		await db.prepare("UPDATE trucks SET odometer = service_miles WHERE id IN ('T01', 'T02', 'T03')").run();
		await packed("000101", 900);
		let r = await planLoads(db, "DISPATCH", day);
		expect(r.loads).toEqual([]);
		expect(r.unplanned[0].reason).toBe("NO TRUCK AVAILABLE");

		await db.prepare("UPDATE trucks SET odometer = 1000 WHERE id = 'T01'").run();
		await db.prepare("UPDATE drivers SET status = 'O'").run();
		r = await planLoads(db, "DISPATCH", day);
		expect(r.unplanned[0].reason).toBe("NO DRIVER AVAILABLE");

		await db.prepare("UPDATE drivers SET status = 'A' WHERE id = 'D03'").run();
		r = await planLoads(db, "DISPATCH", day);
		expect(r.loads).toHaveLength(1);
		expect(r.loads[0]).toMatchObject({ truck_id: "T01", driver_id: "D03" });
		expect(await dutyMinutes(db, "D03", day)).toBe(r.loads[0].duty_min);
	});

	it("changes a planned load's crew, within the rules", async () => {
		const day = freightDay();
		await packed("000101", 900);
		const [l] = (await planLoads(db, "DISPATCH", day)).loads;
		const other = l.driver_id === "D03" ? "D02" : "D03";
		expect((await assignLoad(db, "DISPATCH", l.id, "", other)).driver_id).toBe(other);
		expect((await err(assignLoad(db, "DISPATCH", l.id, "T04", ""))).message).toMatch(/in shop/);
		expect((await err(assignLoad(db, "DISPATCH", l.id, "T99", ""))).field).toBe("truck");
		expect((await err(assignLoad(db, "DISPATCH", l.id, "T03", "D03"))).message).toMatch(/class A license - driver D03 has class B/);
		expect((await err(assignLoad(db, "DISPATCH", l.id, "", "D04"))).message).toMatch(/off/);
		await db.prepare("UPDATE drivers SET cdl_expires = '2020-01-01' WHERE id = 'D01'").run();
		expect((await err(assignLoad(db, "DISPATCH", l.id, "", "D01"))).message).toMatch(/expired/);
	});

	it("dispatches a load, follows it on the board and closes it when the truck is back", async () => {
		const day = freightDay();
		const a = await packed("000101", 900);
		const b = await packed("000101", 300);
		const [l] = (await planLoads(db, "DISPATCH", day)).loads;
		expect((await getLoad(db, l.id)).load.stops).toBe(2);

		// Shipping it by hand is not allowed while it is planned.
		expect((await err(ship(db, "SHIPPER", a.id))).message).toMatch(new RegExp(`on truck load ${l.id}`));

		const { load, shipped } = await dispatchLoad(db, env.TABLES, "DISPATCH", l.id);
		expect(load.status).toBe("D");
		expect(shipped.sort()).toEqual([a.id, b.id].sort());
		const { stops } = await getLoad(db, l.id);
		expect(stops.map((s) => [s.ship_status, s.delivery])).toEqual([["S", "O"], ["S", "O"]]);
		const scans = await trackingEvents(db, a.id);
		expect(scans.map((e) => e.code)).toEqual(["OUTDLVY", "PICKUP", "LABEL"]);
		expect(scans[0].detail).toMatch(new RegExp(`OUT FOR DELIVERY ON TRUCK ${l.truck_id}`));
		const { results: signals } = await db.prepare("SELECT what FROM order_signals WHERE ref = ?").bind(a.invoice_id).all<{ what: string }>();
		expect(signals.map((r) => r.what)).toContain("OUT FOR DELIVERY");
		expect((await err(dispatchLoad(db, env.TABLES, "DISPATCH", l.id))).message).toMatch(/dispatched - it cannot be dispatched/);
		expect((await err(cancelLoad(db, "DISPATCH", l.id))).field).toBe("status");

		let row = (await board(db, day)).find((r) => r.load.id === l.id)!;
		expect(row.next?.shipment_id).toBe(stops[0].shipment_id);
		expect(row.nextEta).not.toBe("");
		await confirmDelivery(db, "DRIVER", stops[0].shipment_id, "SMITH");
		row = (await board(db, day)).find((r) => r.load.id === l.id)!;
		expect(row.next?.shipment_id).toBe(stops[1].shipment_id);
		expect(row.load.delivered).toBe(1);

		const before = (await getTruck(db, l.truck_id)).odometer;
		const back = await returnLoad(db, "DISPATCH", l.id, 0);
		expect(back).toMatchObject({ status: "C", actual_miles: l.miles });
		expect((await getTruck(db, l.truck_id)).odometer).toBe(before + l.miles);
		const log = await db.prepare("SELECT text FROM syslog WHERE text LIKE ?").bind(`CUS1908W LOAD ${l.id}%`).first<{ text: string }>();
		expect(log?.text).toContain("1 STOP(S) NOT SIGNED FOR");
	});

	it("cancels a planned load, and drops a cancelled shipment from one", async () => {
		const day = freightDay();
		const a = await packed("000101", 900);
		const b = await packed("000101", 300);
		const [l] = (await planLoads(db, "DISPATCH", day)).loads;
		// A shipment cancelled in the warehouse comes off the load.
		await db.prepare("DELETE FROM shipments WHERE id = ?").bind(b.id).run();
		expect((await getLoad(db, l.id)).stops.map((s) => s.shipment_id)).toEqual([a.id]);
		await cancelLoad(db, "DISPATCH", l.id);
		expect(await listLoads(db, day)).toEqual([]);
		expect((await waitingShipments(db)).map((w) => w.shipment_id)).toEqual([a.id]);
	});
});

describe("freight screens", () => {
	it("lists the fleet and records a service", async () => {
		const t = await Terminal.logon();
		await t.fill("option", "7").send("ENTER");
		expect(t.scr.map).toBe("CUSM70");
		await t.fill("option", "1").send("ENTER");
		expect(t.scr.map).toBe("CUSF01");
		expect(screenText(t)).toMatch(/T03 +53 FT TRACTOR-TRAILER +44000 A +302775 ACTIVE/);
		expect(screenText(t)).toMatch(/T04 .* IN SHOP +\*\* DUE NOW \*\*/);
		await t.fill("sel:T04", "v").send("ENTER");
		expect(t.message).toMatch(/^CUS1911I TRUCK T04 SERVICED - NEXT DUE AT 76008 MI OR \d{4}-\d\d-\d\d$/);
		await t.fill("sel:T02", "s").send("ENTER");
		expect(t.scr.map).toBe("CUSF02");
		expect(screenText(t)).toContain("FREIGHTLINER M2");
		expect(screenText(t)).toMatch(/TODAY[ .]+NO LOAD/);
		await t.send("PF4");
		await t.fill("odometer", "abc").send("ENTER");
		expect(t.message).toBe("CUS1918E THE ODOMETER MUST BE A WHOLE NUMBER FROM 0 TO 9999999");
		await t.fill("odometer", "122000").send("ENTER");
		expect(t.message).toBe("CUS1917I TRUCK T02 UPDATED");
		expect((await getTruck(db, "T02")).odometer).toBe(122000);
		await t.send("PF3");
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSF03");
		expect(screenText(t)).toMatch(/D04 +PRUITT, DEE .* OFF/);
		await t.send("PF6");
		expect(t.scr.map).toBe("CUSF04");
		await t.fill("id", "d09", "name", "vance, mo", "cdl_class", "b", "cdl_expires", "2029-01-31", "status", "a").send("ENTER");
		expect(t.message).toBe("CUS1917I DRIVER D09 ADDED");
		await db.prepare("DELETE FROM drivers WHERE id = 'D09'").run();
	});

	it("plans, dispatches and shows loads on the dispatch board", async () => {
		const a = await packed("000101", 900);
		const t = await Terminal.logon();
		await t.fill("option", "7.3").send("ENTER");
		expect(t.scr.map).toBe("CUSF05");
		expect(screenText(t)).toContain("1 TRUCK SHIPMENT(S) WAITING FOR A LOAD, 900 LB - PF6 PLANS THEM");
		await t.send("PF6");
		expect(t.message).toBe(`CUS1925I 1 LOAD(S) PLANNED FOR ${freightDay()}`);
		const [l] = await listLoads(db, freightDay());
		expect(t.row(10)).toMatch(new RegExp(`${l.id} +${l.truck_id} +${l.driver_id} +W: OH +1 +900 `));
		await t.fill(`sel:${l.id}`, "s").send("ENTER");
		expect(t.scr.map).toBe("CUSF06");
		expect(screenText(t)).toContain(a.id);
		expect(screenText(t)).toContain("DAYTON");
		expect(t.row(13)).toMatch(/ +1 SHP\d{5} ACME TOOL & DIE +DAYTON +OH +900 +\d+ \+\d:\d\d PACKED/);
		await t.fill("truck", "t04").send("ENTER");
		expect(t.message).toBe("CUS1928E TRUCK T04 IS IN SHOP");
		await t.send("PF10");
		expect(t.message).toBe(`CUS1921I LOAD ${l.id} DISPATCHED ON TRUCK ${l.truck_id} - 1 SHIPMENT(S) OUT FOR DELIVERY`);
		expect(t.row(13)).toContain("OUTDLVY");
		await t.send("PF4");
		expect(t.scr.map).toBe("CUSF07");
		expect(screenText(t)).toMatch(new RegExp(`${l.truck_id} .* ${l.id} +> 0/1 +DAYTON, OH`));
		expect(screenText(t)).toMatch(/T04 +IN SHOP/);
		await t.fill(`sel:${l.id}`, "s").send("ENTER");
		expect(t.scr.map).toBe("CUSF06");
		await t.fill("miles", "150").send("PF10");
		expect(t.message).toBe(`CUS1933W LOAD ${l.id} COMPLETE, 150 MI ON TRUCK ${l.truck_id} - 1 STOP(S) NOT SIGNED FOR`);
		await t.send("PF3");
		expect(t.scr.map).toBe("CUSF07");
		expect(screenText(t)).toContain("COMPLETE");
	});

	it("answers on the REST API", async () => {
		const { accessJWT } = await import("./access");
		const { worker } = await import("./term");
		const headers = { "Cf-Access-Jwt-Assertion": await accessJWT(), "Content-Type": "application/json" };
		const call = (method: string, path: string, body?: unknown) =>
			worker.fetch(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		expect((await call("GET", "/v1/trucks")).status).toBe(200);
		const t = await (await call("GET", "/v1/trucks/t01")).json<Truck>();
		expect(t.id).toBe("T01");
		const { updated: _u, updated_by: _b, ...fields } = t;
		let res = await call("PUT", "/v1/trucks/T01", { ...fields, plate: "OH NEW-1" });
		expect(res.status).toBe(200);
		res = await call("PUT", "/v1/trucks/T01", { ...fields, plate: "OH NEW-2" });
		expect(res.status).toBe(409);
		expect((await call("GET", "/v1/drivers/D01")).status).toBe(200);
		await packed("000101", 900);
		res = await call("POST", "/v1/loads/plan", {});
		expect(res.status).toBe(200);
		const { loads } = await res.json<{ loads: { id: string }[] }>();
		expect((await call("GET", `/v1/loads/${loads[0].id}`)).status).toBe(200);
		expect((await call("POST", `/v1/loads/${loads[0].id}/dispatch`)).status).toBe(200);
		expect((await call("GET", "/v1/dispatch")).status).toBe(200);
		expect((await call("POST", `/v1/loads/${loads[0].id}/return`, { miles: 120 })).status).toBe(200);
		expect((await call("GET", "/v1/loads?day=bad")).status).toBe(422);
		expect((await call("DELETE", "/v1/dispatch")).status).toBe(405);
	});
});
