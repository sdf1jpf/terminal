import { submitJob } from "../jobs";
import {
	assignLoad, board, cancelLoad, dayOf, dispatchLoad, freightDay, getLoad, listLoads, listTrucks, loadStatusNames, MAX_DRIVE_MIN, MAX_DUTY_MIN,
	deliverStop, planLoads, PRETRIP_MIN, returnLoad, stopNotDelivered, serviceState, truckStatusNames, waitingShipments, type LoadSummary, type StopStatus,
} from "../fleet";
import { deliveryShort } from "../tracking";
import { header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type BoardState, type LoadsState, type LoadState, type Next, type Program, type State } from "./program";

// CUSF05 LOADS plans a day's company truck loads (fleet.ts): PF6 groups
// the packed truck shipments waiting into loads, each with a truck, a
// driver and its stops in order, and lists the day's loads. CUSF06 LOAD
// is one load: its crew (changed while it is planned), its stops with
// when the plan has the truck at each, PF10 to dispatch it and, once it
// is out, PF10 when the truck is back. CUSF07 DISPATCH BOARD shows every
// truck's day at a glance.

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

function scroll(s: { top?: number; msg?: string }, aid: string, rows: number, total: number): void {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		s.top = Math.max((s.top ?? 0) - rows, 0);
	} else if ((s.top ?? 0) + rows >= total) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
	} else {
		s.top = Math.min((s.top ?? 0) + rows, total - rows);
	}
}

const loadColor = (l: { status: string }): Color => (l.status === "P" ? "white" : l.status === "D" ? "turquoise" : "green");

function selected(fields: Record<string, string>): [string, string] | undefined {
	for (const [name, v] of Object.entries(fields)) {
		const code = v.trim().toUpperCase();
		if (name.startsWith("sel:") && code) return [name.slice(4), code];
	}
	return undefined;
}

// The day shown: as typed, or today. A bad one shows today, with the error.
function dayShown(s: { day?: string }): string {
	try {
		return dayOf(s.day ?? "");
	} catch {
		return freightDay();
	}
}

// changeDay takes a new date typed on the panel; false if it was bad.
function changeDay(s: LoadsState | BoardState, typed: string): boolean {
	try {
		dayOf(typed);
		s.day = typed.trim();
		return true;
	} catch {
		s.day = typed.trim();
		s.msg = "CUS1920E THE DATE MUST BE YYYY-MM-DD";
		s.errField = "day";
		return false;
	}
}

// ---- CUSF05 LOADS ----

const loadRows = (ctx: Ctx) => ctx.rows - 13;

function loadLine(id: string, truck: string, driver: string, region: string, stops: string, lb: string, mi: string, hrs: string, status: string): string {
	return `${pad(id, 7)} ${pad(truck, 5)} ${pad(driver, 6)} ${pad(region, 16)} ${lpad(stops, 5)} ${lpad(lb, 6)} ${lpad(mi, 6)} ${lpad(hrs, 6)} ${status}`;
}

export function newLoads(back: State, arg = ""): LoadsState | LoadState {
	const a = arg.trim().toUpperCase();
	if (/^(LD)?\d{1,5}$/.test(a)) return { p: "load", back, id: "LD" + a.replace(/^LD/, "").padStart(5, "0") };
	return { p: "loads", back, day: a };
}

export const loads: Program<LoadsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF05");
		header(scr, ctx, "TRUCK LOAD PLANNING");
		let msg = s.msg ?? "";
		const day = dayShown(s);
		let list: LoadSummary[] = [];
		let waiting: Awaited<ReturnType<typeof waitingShipments>> = [];
		try {
			[list, waiting] = await Promise.all([listLoads(ctx.db, day), waitingShipments(ctx.db)]);
		} catch (e) {
			msg = fail(e);
		}
		label(scr, 4, 2, "DATE ===>");
		scr.input(4, 12, 10, "day", s.errField === "day" ? s.day ?? "" : day, { bright: s.errField === "day" });
		scr.text(4, 24, "YYYY-MM-DD, BLANK FOR TODAY", { color: "blue" });
		const lb = waiting.reduce((t, w) => t + w.weight, 0);
		scr.text(5, 2, waiting.length > 0
			? `${waiting.length} TRUCK SHIPMENT(S) WAITING FOR A LOAD, ${lb} LB - PF6 PLANS THEM`
			: "NO TRUCK SHIPMENTS WAITING FOR A LOAD", { color: waiting.length > 0 ? "yellow" : "green" });
		const rows = loadRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		scr.text(6, 2, "SELECT: S=SHOW  D=DISPATCH  X=CANCEL", { color: "blue" });
		if (list.length > 0) scr.text(6, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		scr.text(8, 2, "S " + loadLine("LOAD", "TRUCK", "DRIVER", "REGION", "STOPS", "LB", "MILES", "HOURS", "STATUS"), { color: "white", bright: true });
		scr.text(9, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((l, i) => {
			scr.input(10 + i, 2, 1, "sel:" + l.id, "", { bright: s.errSel === l.id });
			const stops = l.status === "P" ? String(l.stops) : `${l.delivered}/${l.stops}`;
			const long = l.drive_min > MAX_DRIVE_MIN || l.duty_min > MAX_DUTY_MIN;
			scr.text(10 + i, 4, loadLine(l.id, l.truck_id, l.driver_id, l.region, stops, String(l.weight), String(l.status === "C" ? l.actual_miles : l.miles),
				hm(l.duty_min), long && l.status === "P" ? "OVERNIGHT" : loadStatusNames[l.status]), { color: long && l.status === "P" ? "yellow" : loadColor(l) });
		});
		if (list.length === 0) scr.text(10, 4, `NO LOADS FOR ${day}`, { color: "yellow" });
		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF4=BOARD PF5=REFRESH PF6=PLAN PF7/8=SCROLL PF9=MANIFESTS");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.errSel && shown.some((l) => l.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		else scr.cursorTo("day");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const typed = (input.fields.day ?? "").trim();
		if (input.modified.has("day") && typed !== (s.day ?? "") && typed !== dayShown(s)) {
			if (changeDay(s, typed)) s.top = 0;
			if (input.aid === "ENTER") return s;
		}
		const day = dayShown(s);
		switch (input.aid) {
			case "ENTER": {
				const sel = selected(input.fields);
				if (!sel) return s;
				const [id, code] = sel;
				if (code === "S") return { p: "load", back: s, id };
				if (code === "D") {
					try {
						const { load, shipped } = await dispatchLoad(ctx.db, ctx.tables, ctx.user, id);
						s.msg = `CUS1921I LOAD ${load.id} DISPATCHED ON TRUCK ${load.truck_id} - ${shipped.length} SHIPMENT(S) OUT FOR DELIVERY`;
					} catch (e) {
						s.msg = loadError(e, id);
						s.errSel = id;
					}
					return s;
				}
				if (code === "X") {
					try {
						await cancelLoad(ctx.db, ctx.user, id);
						s.msg = `CUS1922I LOAD ${id} CANCELLED - ITS SHIPMENTS ARE WAITING AGAIN`;
					} catch (e) {
						s.msg = loadError(e, id);
						s.errSel = id;
					}
					return s;
				}
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				s.errSel = id;
				return s;
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				return s.back.p === "board" ? s.back : { p: "board", back: s, day: s.day };
			case pf(5):
				s.msg = "CUS1923I LOAD LIST REFRESHED";
				return s;
			case pf(6):
				try {
					const { loads: made, unplanned } = await planLoads(ctx.db, ctx.user, day);
					const left = unplanned.length > 0
						? ` - ${unplanned.length} LEFT WAITING: ${unplanned.slice(0, 2).map((u) => `${u.shipment_id} ${u.reason}`).join(", ")}`
						: "";
					s.msg = made.length === 0 && unplanned.length === 0
						? "CUS1924W NO TRUCK SHIPMENTS ARE WAITING FOR A LOAD"
						: `CUS1925${unplanned.length ? "W" : "I"} ${made.length} LOAD(S) PLANNED FOR ${day}${left}`.slice(0, ctx.cols - 2);
				} catch (e) {
					s.msg = isCode(e, "invalid") ? `CUS1926E ${e.message.toUpperCase()}` : isCode(e, "conflict") ? `CUS1927E ${e.message.toUpperCase()}` : fail(e);
					if (isCode(e, "invalid")) s.errField = "day";
				}
				return s;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, loadRows(ctx), (await listLoads(ctx.db, day)).length);
				return s;
			case pf(9):
				try {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, "CUSLOAD");
					s.msg = `$HASP100 CUSLOAD ON INTRDR - ${job.id} SUBMITTED - MANIFESTS ON OPTION 5.1`;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

function loadError(e: unknown, id: string): string {
	if (isCode(e, "invalid")) return `CUS1928E ${e.message.toUpperCase()}`;
	if (isCode(e, "not_found")) return `CUS1929E LOAD ${id} NOT FOUND`;
	if (isCode(e, "conflict")) return `CUS1930E LOAD ${id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
	return fail(e);
}

// ---- CUSF06 LOAD ----

const stopRows = (ctx: Ctx) => ctx.rows - 14;

function stopLine(seq: string, shp: string, name: string, city: string, st: string, lb: string, mi: string, eta: string, status: string): string {
	return `${lpad(seq, 4)} ${pad(shp, 8)} ${pad(name, 15)} ${pad(city, 11)} ${pad(st, 2)} ${lpad(lb, 6)} ${lpad(mi, 5)} ${pad(eta, 5)} ${status}`;
}

const stopColor = (x: StopStatus): Color =>
	x.pod_status === "D" ? "green" : x.pod_status === "X" ? "red" : x.delivery === "O" ? "yellow" : "turquoise";

export const load: Program<LoadState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF06");
		header(scr, ctx, "TRUCK LOAD");
		let msg = s.msg ?? "";
		let legend = "PF1=HELP  PF3=EXIT  PF12=CANCEL";
		try {
			const { load: l, stops, truck, driver } = await getLoad(ctx.db, s.id);
			const col = right(scr, 50);
			label(scr, 4, 2, "LOAD");
			scr.text(4, 7, l.id, { color: "white", bright: true });
			scr.text(4, 15, loadStatusNames[l.status], { color: loadColor(l), bright: true });
			label(scr, 4, col, "DATE");
			scr.text(4, col + 5, `${l.day}  ${l.region}`.slice(0, scr.cols - col - 6), { color: "white" });
			const editable = l.status === "P";
			label(scr, 5, 2, "TRUCK ===>");
			if (editable) scr.input(5, 13, 8, "truck", s.vals?.truck ?? truck.id, { bright: s.errField === "truck" });
			else scr.text(5, 13, truck.id, { color: "white" });
			scr.text(5, 23, `${truck.name}  ${truck.capacity_lb} LB  CLASS ${truck.cdl_class}`.slice(0, scr.cols - 24), { color: "green" });
			label(scr, 6, 2, "DRIVER ==>");
			if (editable) scr.input(6, 13, 8, "driver", s.vals?.driver ?? driver.id, { bright: s.errField === "driver" });
			else scr.text(6, 13, driver.id, { color: "white" });
			scr.text(6, 23, `${driver.name}  CLASS ${driver.cdl_class}  ${driver.phone}`.slice(0, scr.cols - 24), { color: "green" });
			const long = l.drive_min > MAX_DRIVE_MIN || l.duty_min > MAX_DUTY_MIN;
			scr.text(7, 2, `${l.stops} STOPS  ${l.cartons} CTN  ${l.weight} OF ${truck.capacity_lb} LB  ${l.miles} MI OUT AND BACK  ` +
				`${hm(l.drive_min)} DRIVING  ${hm(l.duty_min)} ON DUTY${long ? "  OVERNIGHT" : ""}`.slice(0, scr.cols - 3), { color: long ? "yellow" : "white" });
			const when: string[] = [];
			if (l.dispatched) when.push(`LEFT ${stamp(ctx, l.dispatched).slice(5)} BY ${l.dispatched_by}`);
			if (l.returned) when.push(`BACK ${stamp(ctx, l.returned).slice(5)}, ${l.actual_miles} MI`);
			else if (l.dispatched) when.push(`DUE BACK ${stamp(ctx, new Date(Date.parse(l.dispatched) + (l.duty_min - PRETRIP_MIN) * 60_000).toISOString()).slice(11)}`);
			if (when.length > 0) scr.text(8, 2, when.join("  "), { color: "green" });
			if (l.status === "D") {
				label(scr, 9, 2, "SIGNED BY/WHY ===>");
				scr.input(9, 21, 20, "signed", s.vals?.signed ?? "", { bright: s.errField === "signed" });
				label(scr, 9, 43, "CTN ===>");
				scr.input(9, 52, 3, "cartons", s.vals?.cartons ?? "", { numeric: true, bright: s.errField === "cartons" });
				label(scr, 9, 57, "MILES BACK ===>");
				scr.input(9, 73, 5, "miles", s.vals?.miles ?? "", { numeric: true, bright: s.errField === "miles" });
			}

			const rows = stopRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(stops.length - rows, 0));
			scr.text(10, 2, l.status === "D" ? "SELECT: S=SHIPMENT  T=TRACK  D=DELIVERED  X=NOT DELIVERED" : "SELECT: S=SHIPMENT  T=TRACK", { color: "blue" });
			if (stops.length > rows) scr.text(10, right(scr, 66), `${top + 1}-${Math.min(top + rows, stops.length)}/${stops.length}`, { color: "white" });
			scr.text(11, 2, "S " + stopLine("STOP", "SHIPMENT", "SHIP TO", "CITY", "ST", "LB", "MILES", "ETA", "STATUS"), { color: "white", bright: true });
			scr.text(12, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			const left = l.dispatched ? Date.parse(l.dispatched) : NaN;
			stops.slice(top, top + rows).forEach((x, i) => {
				scr.input(13 + i, 2, 1, "sel:" + x.shipment_id, "", { bright: s.errSel === x.shipment_id });
				const eta = x.pod_at ? stamp(ctx, x.pod_at).slice(11)
					: isNaN(left) ? "+" + hm(x.eta_min) : stamp(ctx, new Date(left + x.eta_min * 60_000).toISOString()).slice(11);
				const status = x.pod_status === "D" ? `DLVD ${x.pod_signed}` : x.pod_status === "X" ? `NOT ${x.pod_note}`
					: x.ship_status !== "S" ? "PACKED" : x.delivery === "X" ? "REDELIVER" : deliveryShort[x.delivery];
				scr.text(13 + i, 4, stopLine(String(x.seq), x.shipment_id, x.name, x.city, x.state, String(x.weight), String(x.leg_miles), eta, status).slice(0, scr.cols - 4), { color: stopColor(x) });
			});
			if (stops.length === 0) scr.text(13, 4, "NO STOPS LEFT - PF9 CANCELS THE LOAD", { color: "yellow" });
			legend = l.status === "P"
				? "ENTER=CHANGE CREW PF3=EXIT PF4=BOARD PF7/8=SCROLL PF9=CANCEL PF10=DISPATCH"
				: l.status === "D"
					? "PF1=HELP  PF3=EXIT  PF4=BOARD  PF7=UP  PF8=DOWN  PF10=TRUCK BACK  PF12=CANCEL"
					: "PF1=HELP  PF3=EXIT  PF4=BOARD  PF7=UP  PF8=DOWN  PF12=CANCEL";
			if (s.errField) scr.cursorTo(s.errField);
			else if (s.errSel) scr.cursorTo("sel:" + s.errSel);
			else if (l.status === "D") scr.cursorTo(stops.some((x) => x.pod_status === "") ? "signed" : "miles");
			else if (l.status === "P") scr.cursorTo("truck");
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS1929E LOAD ${s.id} NOT FOUND` : fail(e);
		}
		message(scr, msg);
		keys(scr, legend);
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errField = s.errSel = s.confirm = undefined;
		const f = input.fields;
		s.vals = {
			truck: (f.truck ?? "").trim().toUpperCase(), driver: (f.driver ?? "").trim().toUpperCase(), miles: (f.miles ?? "").trim(),
			signed: (f.signed ?? "").trim().toUpperCase(), cartons: (f.cartons ?? "").trim(),
		};
		const act = async (fn: () => Promise<Next>): Promise<Next> => {
			try {
				return await fn();
			} catch (e) {
				if (isCode(e, "invalid") && e.field && ["truck", "driver", "miles", "signed", "cartons"].includes(e.field)) s.errField = e.field;
				s.msg = loadError(e, s.id);
				return s;
			}
		};
		switch (input.aid) {
			case "ENTER": {
				const sel = selected(f);
				if (sel) {
					const [id, code] = sel;
					if (code === "S") return { p: "shipment", back: s, id };
					if (code === "T") return { p: "tracking", back: s, id };
					if (code === "D" || code === "X") {
						s.errSel = id;
						return act(async () => {
							const ctn = s.vals!.cartons;
							const x = code === "D"
								? await deliverStop(ctx.db, ctx.user, s.id, id, s.vals!.signed, /^\d+$/.test(ctn) ? Number(ctn) : ctn ? NaN : 0)
								: await stopNotDelivered(ctx.db, ctx.user, s.id, id, s.vals!.signed);
							s.vals = undefined;
							s.errSel = undefined;
							s.msg = x.pod_status === "D"
								? `CUS1942I STOP ${x.seq} DELIVERED, ${x.pod_cartons} CTN SIGNED FOR BY ${x.pod_signed}${x.pod_note ? " - " + x.pod_note : ""}`
								: `CUS1943W STOP ${x.seq} NOT DELIVERED: ${x.pod_note} - ${x.shipment_id} COMES BACK FOR ANOTHER LOAD`;
							return s;
						});
					}
					s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
					s.errSel = id;
					return s;
				}
				if (!input.modified.has("truck") && !input.modified.has("driver")) return s;
				return act(async () => {
					const l = await assignLoad(ctx.db, ctx.user, s.id, s.vals!.truck, s.vals!.driver);
					s.vals = undefined;
					s.msg = `CUS1931I LOAD ${l.id} ON TRUCK ${l.truck_id} WITH DRIVER ${l.driver_id}`;
					return s;
				});
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				return s.back.p === "board" ? s.back : { p: "board", back: s };
			case pf(7):
			case pf(8):
				scroll(s, input.aid, stopRows(ctx), (await getLoad(ctx.db, s.id).catch(() => ({ stops: [] }))).stops.length);
				return s;
			case pf(9):
				if (!confirm) {
					s.confirm = true;
					s.msg = `CUS1932W PRESS PF9 AGAIN TO CANCEL ${s.id} - ITS SHIPMENTS WAIT FOR ANOTHER LOAD`;
					return s;
				}
				return act(async () => {
					await cancelLoad(ctx.db, ctx.user, s.id);
					if (s.back.p === "loads") s.back.msg = `CUS1922I LOAD ${s.id} CANCELLED - ITS SHIPMENTS ARE WAITING AGAIN`;
					return s.back;
				});
			case pf(10):
				return act(async () => {
					const { load: l } = await getLoad(ctx.db, s.id);
					if (l.status === "P") {
						const { shipped } = await dispatchLoad(ctx.db, ctx.tables, ctx.user, s.id);
						s.vals = undefined;
						s.msg = `CUS1921I LOAD ${s.id} DISPATCHED ON TRUCK ${l.truck_id} - ${shipped.length} SHIPMENT(S) OUT FOR DELIVERY`;
						return s;
					}
					if (l.status === "D") {
						const mi = s.vals!.miles;
						const back = await returnLoad(ctx.db, ctx.user, s.id, /^\d+$/.test(mi) ? Number(mi) : mi ? NaN : 0);
						s.vals = undefined;
						s.msg = `CUS1933${back.missed ? "W" : "I"} LOAD ${s.id} COMPLETE, ${back.actual_miles} MI ON TRUCK ${back.truck_id}` +
							(back.missed ? ` - ${back.missed} SHIPMENT(S) WAIT TO BE REDELIVERED` : "");
						return s;
					}
					s.msg = invalidKey(input.aid);
					return s;
				});
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// ---- CUSF07 DISPATCH BOARD ----

function boardLine(truck: string, driver: string, load: string, progress: string, next: string, eta: string, back: string): string {
	return `${pad(truck, 5)} ${pad(driver, 14)} ${pad(load, 7)} ${pad(progress, 14)} ${pad(next, 20)} ${pad(eta, 5)} ${back}`;
}

export const dispatchBoard: Program<BoardState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF07");
		header(scr, ctx, "DISPATCH BOARD");
		let msg = s.msg ?? "";
		const day = dayShown(s);
		label(scr, 4, 2, "DATE ===>");
		scr.input(4, 12, 10, "day", s.errField === "day" ? s.day ?? "" : day, { bright: s.errField === "day" });
		scr.text(4, 24, "S=LOAD  * DELIVERED  X NOT DELIVERED  > NEXT  . TO GO", { color: "blue" });
		scr.text(6, 2, "S " + boardLine("TRUCK", "DRIVER", "LOAD", "PROGRESS", "NEXT STOP", "ETA", "BACK"), { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		let row = 8;
		try {
			const rows = await board(ctx.db, day);
			const onLoad = new Set(rows.map((r) => r.truck.id));
			for (const r of rows) {
				if (row > ctx.rows - 3) break;
				const { load: l } = r;
				scr.input(row, 2, 1, "sel:" + l.id, "", { bright: s.errSel === l.id });
				const marks = r.stops.map((x) => (x.pod_status === "D" ? "*" : x.pod_status === "X" ? "X" : x === r.next && l.status === "D" ? ">" : ".")).join("");
				const progress = l.status === "P" ? "PLANNED" : l.status === "C" ? (l.missed ? `COMPLETE ${l.missed}X` : "COMPLETE")
					: `${marks.slice(0, 8)} ${l.delivered + l.missed}/${l.stops}`;
				const next = r.next ? `${r.next.city}, ${r.next.state}` : l.status === "D" ? "RETURNING" : "";
				const eta = r.nextEta ? stamp(ctx, r.nextEta).slice(11) : "";
				const back = l.returned ? stamp(ctx, l.returned).slice(11) : r.backEta ? stamp(ctx, r.backEta).slice(11) : "";
				const color: Color = r.late ? "red" : l.status === "C" ? "green" : l.status === "D" ? "turquoise" : "white";
				scr.text(row, 4, boardLine(r.truck.id, r.driver.name, l.id, progress, next, eta, back), { color });
				row++;
			}
			// The rest of the fleet: free, in the shop or due for service.
			for (const t of await listTrucks(ctx.db)) {
				if (onLoad.has(t.id) || t.status === "R" || row > ctx.rows - 3) continue;
				const why = t.status === "S" ? truckStatusNames.S : serviceState(t, day) === "DUE" ? "SERVICE DUE" : "AVAILABLE";
				scr.text(row++, 4, boardLine(t.id, "", "", why, "", "", ""), { color: why === "AVAILABLE" ? "blue" : "yellow" });
			}
			if (rows.length === 0) msg ||= `CUS1934I NO LOADS ON ${day} - OPTION 7.3 PLANS THEM`;
		} catch (e) {
			msg = fail(e);
		}
		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF4=LOADS  PF5=REFRESH  PF12=CANCEL");
		if (s.errField) scr.cursorTo(s.errField);
		else scr.cursorTo("day");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const typed = (input.fields.day ?? "").trim();
		if (input.modified.has("day") && typed !== (s.day ?? "") && typed !== dayShown(s)) {
			changeDay(s, typed);
			if (input.aid === "ENTER") return s;
		}
		switch (input.aid) {
			case "ENTER": {
				const sel = selected(input.fields);
				if (!sel) return s;
				const [id, code] = sel;
				if (code === "S") return { p: "load", back: s, id };
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				s.errSel = id;
				return s;
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				return s.back.p === "loads" ? s.back : { p: "loads", back: s, day: s.day };
			case pf(5):
				s.msg = `CUS1935I BOARD REFRESHED AT ${stamp(ctx, new Date().toISOString()).slice(11)}`;
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
