import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	assignLoad, board, cancelLoad, deliverStop, freightCosts, dispatchLoad, stopNotDelivered, dutyMinutes, freightDay, getLoad, getTruck, group, listLoads, planLoads, returnLoad, schedule,
	sequence, serviceState, truckServiced, waitingShipments, type Driver, type Truck, type Waiting,
} from "../src/fleet";
import { bearing, DEPOT, locate, miles } from "../src/geo";
import { HttpError } from "../src/http";
import { journal } from "../src/ledger";
import { addLine, createInvoice } from "../src/invoices";
import { pack, release, ship, type Shipment } from "../src/shipping";
import { lookAtInvoice, timeline } from "../src/lifecycle";
import { confirmDelivery, getTracking, trackingEvents } from "../src/tracking";
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
			return { shipment_id: id, invoice_id: "", customer_id: "", name: "", city, state: st, cartons: 1, weight, ...p, bearing: bearing(DEPOT, p), redeliver: false };
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

		// Signing off by hand from tracking signs off the stop.
		expect((await getLoad(db, l.id)).stops[0]).toMatchObject({ pod_status: "D", pod_signed: "SMITH", pod_cartons: 2 });

		// It comes back only when every stop is signed off.
		expect((await err(returnLoad(db, env.TABLES, "DISPATCH", l.id, 0))).message).toMatch(/1 stop\(s\) on load .* have no proof of delivery/);
		const before = (await getTruck(db, l.truck_id)).odometer;
		await stopNotDelivered(db, "DRIVER", l.id, stops[1].shipment_id, "receiver closed");
		const back = await returnLoad(db, env.TABLES, "DISPATCH", l.id, 0);
		expect(back).toMatchObject({ status: "C", actual_miles: l.miles, delivered: 1, missed: 1 });
		expect((await getTruck(db, l.truck_id)).odometer).toBe(before + l.miles);
		const log = await db.prepare("SELECT text FROM syslog WHERE text LIKE ?").bind(`CUS1908W LOAD ${l.id}%`).first<{ text: string }>();
		expect(log?.text).toContain("1 SHIPMENT(S) BACK TO REDELIVER");
	});

	it("takes proof of delivery and redelivers what came back", async () => {
		const day = freightDay();
		const a = await packed("000101", 900);
		const [l] = (await planLoads(db, "DISPATCH", day)).loads;
		expect((await err(deliverStop(db, "DRIVER", l.id, a.id, "SMITH"))).message).toMatch(/planned - stops are signed off while it is out/);
		await dispatchLoad(db, env.TABLES, "DISPATCH", l.id);
		expect((await err(deliverStop(db, "DRIVER", l.id, a.id, " "))).field).toBe("signed");
		expect((await err(deliverStop(db, "DRIVER", l.id, a.id, "SMITH", 9))).field).toBe("cartons");
		expect((await err(deliverStop(db, "DRIVER", l.id, "SHP99999", "SMITH"))).code).toBe("not_found");

		// Not delivered: an exception on the order, and it waits again.
		const x = await stopNotDelivered(db, "DRIVER", l.id, a.id, "dock closed");
		expect(x).toMatchObject({ pod_status: "X", pod_note: "DOCK CLOSED", delivery: "X" });
		expect((await trackingEvents(db, a.id))[0]).toMatchObject({ code: "EXCEPTION", location: "DAYTON, OH", detail: "NOT DELIVERED: DOCK CLOSED - BACK TO WAREHOUSE" });
		const { results: signals } = await db.prepare("SELECT what FROM order_signals WHERE ref = ?").bind(a.invoice_id).all<{ what: string }>();
		expect(signals.map((r) => r.what)).toContain("DELIVERY EXCEPTION");
		// It rides back on the truck, and waits for the next load.
		await returnLoad(db, env.TABLES, "DISPATCH", l.id, 0);
		const waiting = await waitingShipments(db);
		expect(waiting.map((w) => [w.shipment_id, w.redeliver])).toEqual([[a.id, true]]);
		// Asking tracking about it while it waits changes nothing.
		expect((await getTracking(db, env.TABLES, a.id, true)).shipment.delivery).toBe("X");

		// The next load takes it out again, without shipping it twice.
		const [again] = (await planLoads(db, "DISPATCH", day)).loads;
		expect(again.truck_id).not.toBe(l.truck_id);
		expect((await getTracking(db, env.TABLES, a.id, true)).shipment.delivery).toBe("X");
		const { shipped } = await dispatchLoad(db, env.TABLES, "DISPATCH", again.id);
		expect(shipped).toEqual([a.id]);
		const shp = (await getTracking(db, env.TABLES, a.id)).shipment;
		expect(shp).toMatchObject({ status: "S", delivery: "O" });
		const y = await deliverStop(db, "DRIVER", again.id, a.id, "jones", 1, "");
		expect(y).toMatchObject({ pod_status: "D", pod_signed: "JONES", pod_cartons: 1, pod_note: "SHORT 1 CTN", delivery: "D", signed_by: "JONES" });
		expect((await trackingEvents(db, a.id))[0].detail).toBe("DELIVERED, SIGNED BY JONES - SHORT 1 CTN");
		expect((await err(deliverStop(db, "DRIVER", again.id, a.id, "JONES"))).message).toMatch(/already signed off/);
		await lookAtInvoice(db, a.invoice_id);
		const tl = (await timeline(db, "I", a.invoice_id)).map((e) => e.event);
		expect(tl).toEqual(expect.arrayContaining(["SHIPPED", "OUT FOR DLVY", "EXCEPTION", "DELIVERED"]));
		const row = (await board(db, day)).find((r) => r.load.id === again.id)!;
		expect(row.next).toBeUndefined();
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

describe("freight costs", () => {
	it("costs truck loads against the carriers and posts freight to the ledger", async () => {
		const day = freightDay();
		const ups = await packed("000101", 20);
		expect(ups).toMatchObject({ carrier: "UPS", freight_cost: 30 }); // 12.50 + 0.85 x 20 lb
		await ship(db, "SHIPPER", ups.id);
		const a = await packed("000101", 900);
		const b = await packed("000101", 300);
		expect(a.freight_cost).toBe(0);
		const [l] = (await planLoads(db, "DISPATCH", day)).loads;
		await dispatchLoad(db, env.TABLES, "DISPATCH", l.id);
		await deliverStop(db, "DRIVER", l.id, a.id, "SMITH");
		await deliverStop(db, "DRIVER", l.id, b.id, "SMITH");
		const back = await returnLoad(db, env.TABLES, "DISPATCH", l.id, 100);
		const { truck, driver } = await getLoad(db, l.id);
		expect(back.cost_miles).toBe(Math.round(100 * truck.cost_per_mile));
		expect(back.cost_labor).toBeGreaterThanOrEqual(Math.round(0.5 * driver.hourly_rate)); // at least the pre-trip
		// FedEx Freight would have taken both: $95 + 0.42 a lb each.
		expect(back.cost_carrier).toBe(Math.round(95 + 0.42 * 900 + 95 + 0.42 * 300));
		// The cost is shared over the shipments by weight.
		const shares = (await db.prepare("SELECT id, freight_cost FROM shipments WHERE id IN (?, ?)").bind(a.id, b.id).all<{ id: string; freight_cost: number }>()).results;
		expect(shares.reduce((t, r) => t + r.freight_cost, 0)).toBe(back.cost_miles + back.cost_labor);
		expect(shares.find((r) => r.id === a.id)!.freight_cost).toBeGreaterThan(shares.find((r) => r.id === b.id)!.freight_cost);

		const fc = await freightCosts(db, day.slice(0, 7));
		const row = fc.loads.find((r) => r.load.id === l.id)!;
		expect(row).toMatchObject({ cost: back.cost_miles + back.cost_labor, saved: back.cost_carrier - back.cost_miles - back.cost_labor });
		expect(fc.carriers.find((c) => c.carrier === "UPS")!.cost).toBeGreaterThanOrEqual(30);
		expect((await err(freightCosts(db, "2026-13"))).field).toBe("month");

		await journal(db, "TESTGL");
		const entries = (await db.prepare("SELECT source, account, debit, credit FROM gl_entries WHERE source IN (?, ?) ORDER BY source, account")
			.bind("L:" + l.id, "F:" + ups.id).all()).results;
		expect(entries).toEqual([
			{ source: "F:" + ups.id, account: "2100", debit: 0, credit: 30 },
			{ source: "F:" + ups.id, account: "5200", debit: 30, credit: 0 },
			{ source: "L:" + l.id, account: "2110", debit: 0, credit: back.cost_miles + back.cost_labor },
			{ source: "L:" + l.id, account: "5210", debit: back.cost_miles + back.cost_labor, credit: 0 },
		]);

		const t = await Terminal.logon();
		await t.fill("option", "7.5").send("ENTER");
		expect(t.scr.map).toBe("CUSF08");
		expect(screenText(t)).toContain(l.id);
		expect(screenText(t)).toMatch(/CARRIERS WOULD HAVE CHARGED \$[\d,]+ - THE TRUCK (SAVED|COST)/);
		await t.fill("month", "2026-13").send("ENTER");
		expect(t.message).toBe("CUS1944E THE MONTH MUST BE YYYY-MM");
		await t.send("PF3");
		await t.fill("option", "3").send("ENTER");
		await t.fill(`sel:${l.id}`, "s").send("ENTER");
		expect(screenText(t)).toMatch(/COST \$[\d,]+ \(MILES \$[\d,]+, DRIVER \$[\d,]+\)  CARRIERS \$[\d,]+/);
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
		expect(t.message).toMatch(/^CUS1928E 1 STOP\(S\) ON LOAD .* HAVE NO PROOF OF DELIVERY/);
		await t.fill(`sel:${a.id}`, "d").send("ENTER");
		expect(t.message).toBe("CUS1928E ENTER WHO SIGNED FOR IT");
		expect(t.scr.cursor).toEqual({ field: "signed" });
		await t.fill(`sel:${a.id}`, "d", "signed", "garcia").send("ENTER");
		expect(t.message).toBe("CUS1942I STOP 1 DELIVERED, 2 CTN SIGNED FOR BY GARCIA");
		expect(t.row(13)).toContain("DLVD GARCIA");
		await t.fill("miles", "150").send("PF10");
		expect(t.message).toBe(`CUS1933I LOAD ${l.id} COMPLETE, 150 MI ON TRUCK ${l.truck_id}`);
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
		const { stops } = await (await call("GET", `/v1/loads/${loads[0].id}`)).json<{ stops: { shipment_id: string }[] }>();
		expect((await call("POST", `/v1/loads/${loads[0].id}/return`, { miles: 120 })).status).toBe(422);
		res = await call("POST", `/v1/loads/${loads[0].id}/stops/${stops[0].shipment_id}/delivered`, { signed_by: "X", cartons: 0, note: "" });
		expect(res.status).toBe(200);
		expect((await call("POST", `/v1/loads/${loads[0].id}/stops/${stops[0].shipment_id}/missed`, { reason: "X" })).status).toBe(422);
		expect((await call("POST", `/v1/loads/${loads[0].id}/return`, { miles: 120 })).status).toBe(200);
		expect((await call("GET", "/v1/loads?day=bad")).status).toBe(422);
		expect((await call("DELETE", "/v1/dispatch")).status).toBe(405);
	});
});
