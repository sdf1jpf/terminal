import {
	addDays, driverStatusNames, dutyMinutes, freightDay, getDriver, getTruck, listDrivers, listTrucks, parseDriver, parseTruck,
	saveDriver, saveTruck, serviceState, truckServiced, truckStatusNames, WEEK_DUTY_MIN, type Driver, type Truck,
} from "../fleet";
import { dots, header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, value, type Color, type Ctx, type Screen } from "./screen";
import { fail, isCode, pf, type DriversState, type FleetItemState, type Next, type Program, type State, type TrucksState } from "./program";

// CUSF01 TRUCKS and CUSF03 DRIVERS list the company's fleet (fleet.ts):
// each truck's capacity, odometer and when its next service is due, and
// each driver's license and hours on duty this week. CUSF02 TRUCK and
// CUSF04 DRIVER show, add and change one; PF5 on a truck records a service.

const listRows = (ctx: Ctx) => ctx.rows - 10;

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

const hours = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

// todaysLoads maps each truck and driver on a load today to the load.
async function todaysLoads(ctx: Ctx): Promise<Map<string, string>> {
	const { results } = await ctx.db.prepare("SELECT id, truck_id, driver_id, status FROM loads WHERE day = ?").bind(freightDay())
		.all<{ id: string; truck_id: string; driver_id: string; status: string }>();
	const m = new Map<string, string>();
	for (const r of results) {
		const what = `${r.id}${r.status === "D" ? " OUT" : r.status === "C" ? " BACK" : ""}`;
		m.set("T:" + r.truck_id, what);
		m.set("D:" + r.driver_id, what);
	}
	return m;
}

// serviceText says when a truck's service is due, and its color.
function serviceText(t: Truck): [string, Color] {
	if (t.status === "R") return ["", "blue"];
	const st = serviceState(t);
	if (st === "DUE") return ["** DUE NOW **", "red"];
	if (st === "SOON") return [`DUE ${t.service_due.slice(5) || t.service_miles}`, "yellow"];
	return [t.service_due || (t.service_miles ? `AT ${t.service_miles}` : ""), "green"];
}

function selected(input: { fields: Record<string, string> }): [string, string] | undefined {
	for (const [name, v] of Object.entries(input.fields)) {
		const code = v.trim().toUpperCase();
		if (name.startsWith("sel:") && code) return [name.slice(4), code];
	}
	return undefined;
}

function truckLine(id: string, name: string, cap: string, cls: string, odo: string, status: string, svc: string, today: string): string {
	return `${pad(id, 5)} ${pad(name, 22)} ${lpad(cap, 6)} ${pad(cls, 2)} ${lpad(odo, 8)} ${pad(status, 7)} ${pad(svc, 13)} ${today}`;
}

export const trucks: Program<TrucksState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF01");
		header(scr, ctx, "FLEET - TRUCKS");
		let msg = s.msg ?? "";
		let list: Truck[] = [];
		try {
			list = await listTrucks(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const today = await todaysLoads(ctx);
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		scr.text(4, 2, "SELECT: S=SHOW  U=UPDATE  V=SERVICED", { color: "blue" });
		if (list.length > 0) scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		scr.text(6, 2, "S " + truckLine("TRUCK", "DESCRIPTION", "CAP LB", "CL", "ODOMETER", "STATUS", "NEXT SERVICE", "TODAY"), { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((t, i) => {
			const [svc, svcColor] = serviceText(t);
			scr.input(8 + i, 2, 1, "sel:" + t.id, "", { bright: s.errSel === t.id });
			const color: Color = t.status === "R" ? "blue" : t.status === "S" ? "yellow" : svcColor === "red" ? "red" : "turquoise";
			scr.text(8 + i, 4, truckLine(t.id, t.name, String(t.capacity_lb), t.cdl_class, String(t.odometer), truckStatusNames[t.status], svc,
				today.get("T:" + t.id) ?? ""), { color });
		});
		if (list.length === 0) scr.text(8, 4, "NO TRUCKS ON FILE - PF6 ADDS ONE", { color: "yellow" });
		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF4=DRIVERS PF5=REFRESH PF6=ADD PF7=UP PF8=DOWN PF12=CANCEL");
		if (s.errSel && shown.some((t) => t.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER": {
				const sel = selected(input);
				if (!sel) return s;
				const [id, code] = sel;
				if (code === "S") return { p: "fleetitem", kind: "T", mode: "inquiry", back: s, id };
				if (code === "U") return openUpdate(ctx, { p: "fleetitem", kind: "T", mode: "inquiry", back: s, id });
				if (code === "V") {
					try {
						const t = await truckServiced(ctx.db, ctx.user, id);
						s.msg = `CUS1911I TRUCK ${t.id} SERVICED - NEXT DUE AT ${t.service_miles} MI OR ${t.service_due}`;
					} catch (e) {
						s.msg = isCode(e, "invalid") ? `CUS1912E ${e.message.toUpperCase()}` : fail(e);
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
				return s.back.p === "drivers" ? s.back : { p: "drivers", back: s };
			case pf(5):
				s.msg = "CUS1913I TRUCK LIST REFRESHED";
				return s;
			case pf(6):
				return { p: "fleetitem", kind: "T", mode: "add", back: s };
			case pf(7):
			case pf(8):
				scroll(s, input.aid, listRows(ctx), (await listTrucks(ctx.db)).length);
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

function driverLine(id: string, name: string, phone: string, cls: string, expires: string, status: string, week: string, today: string): string {
	return `${pad(id, 5)} ${pad(name, 20)} ${pad(phone, 12)} ${pad(cls, 2)} ${pad(expires, 10)} ${pad(status, 9)} ${lpad(week, 6)} ${today}`;
}

export const drivers: Program<DriversState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF03");
		header(scr, ctx, "FLEET - DRIVERS");
		let msg = s.msg ?? "";
		let list: Driver[] = [];
		try {
			list = await listDrivers(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const day = freightDay();
		const today = await todaysLoads(ctx);
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		scr.text(4, 2, "SELECT: S=SHOW  U=UPDATE", { color: "blue" });
		scr.text(5, 2, `HOURS ON DUTY IN THE 7 DAYS TO ${day}, OF ${WEEK_DUTY_MIN / 60} ALLOWED`, { color: "blue" });
		if (list.length > 0) scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		scr.text(6, 2, "S " + driverLine("DRVR", "NAME", "PHONE", "CL", "CDL EXPIRE", "STATUS", "HOURS", "TODAY"), { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		for (const [i, d] of shown.entries()) {
			const used = await dutyMinutes(ctx.db, d.id, day);
			const expired = d.cdl_expires < day;
			const soon = !expired && d.cdl_expires < addDays(day, 30);
			scr.input(8 + i, 2, 1, "sel:" + d.id, "", { bright: s.errSel === d.id });
			const color: Color = expired ? "red" : d.status !== "A" ? "blue" : soon || used > WEEK_DUTY_MIN - 8 * 60 ? "yellow" : "turquoise";
			scr.text(8 + i, 4, driverLine(d.id, d.name, d.phone, d.cdl_class, expired ? "EXPIRED" : d.cdl_expires, driverStatusNames[d.status],
				hours(used), today.get("D:" + d.id) ?? ""), { color });
		}
		if (list.length === 0) scr.text(8, 4, "NO DRIVERS ON FILE - PF6 ADDS ONE", { color: "yellow" });
		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF4=TRUCKS PF5=REFRESH PF6=ADD PF7=UP PF8=DOWN PF12=CANCEL");
		if (s.errSel && shown.some((d) => d.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER": {
				const sel = selected(input);
				if (!sel) return s;
				const [id, code] = sel;
				if (code === "S") return { p: "fleetitem", kind: "D", mode: "inquiry", back: s, id };
				if (code === "U") return openUpdate(ctx, { p: "fleetitem", kind: "D", mode: "inquiry", back: s, id });
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				s.errSel = id;
				return s;
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				return s.back.p === "trucks" ? s.back : { p: "trucks", back: s };
			case pf(5):
				s.msg = "CUS1914I DRIVER LIST REFRESHED";
				return s;
			case pf(6):
				return { p: "fleetitem", kind: "D", mode: "add", back: s };
			case pf(7):
			case pf(8):
				scroll(s, input.aid, listRows(ctx), (await listDrivers(ctx.db)).length);
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// ---- CUSF02 TRUCK, CUSF04 DRIVER ----

interface FieldDef {
	name: string;
	label: string;
	len: number;
	numeric?: boolean;
	hint?: string;
}

const truckFields: FieldDef[] = [
	{ name: "name", label: "DESCRIPTION", len: 34 },
	{ name: "plate", label: "PLATE", len: 12 },
	{ name: "capacity_lb", label: "CAPACITY (LB)", len: 6, numeric: true, hint: "PAYLOAD" },
	{ name: "cdl_class", label: "LICENSE CLASS", len: 1, hint: "A, B OR C - THE CDL IT TAKES TO DRIVE IT" },
	{ name: "odometer", label: "ODOMETER", len: 7, numeric: true },
	{ name: "status", label: "STATUS", len: 1, hint: "A=ACTIVE  S=IN SHOP  R=RETIRED" },
	{ name: "service_miles", label: "SERVICE DUE AT MI", len: 7, numeric: true },
	{ name: "service_due", label: "OR ON", len: 10, hint: "YYYY-MM-DD, WHICHEVER COMES FIRST" },
];

const driverFields: FieldDef[] = [
	{ name: "name", label: "NAME", len: 30, hint: "LAST, FIRST" },
	{ name: "phone", label: "PHONE", len: 14 },
	{ name: "cdl_class", label: "LICENSE CLASS", len: 1, hint: "A DRIVES ANY TRUCK, B A B OR C, C ONLY A C" },
	{ name: "cdl_expires", label: "LICENSE EXPIRES", len: 10, hint: "YYYY-MM-DD" },
	{ name: "status", label: "STATUS", len: 1, hint: "A=AVAILABLE  O=OFF  L=ON LEAVE" },
];

const defs = (s: FleetItemState) => (s.kind === "T" ? truckFields : driverFields);
const noun = (s: FleetItemState) => (s.kind === "T" ? "TRUCK" : "DRIVER");

async function loadItem(ctx: Ctx, s: FleetItemState): Promise<Truck | Driver | undefined> {
	if (!s.id) return undefined;
	try {
		return s.kind === "T" ? await getTruck(ctx.db, s.id) : await getDriver(ctx.db, s.id);
	} catch (e) {
		if (isCode(e, "not_found")) return undefined;
		throw e;
	}
}

async function openUpdate(ctx: Ctx, s: FleetItemState): Promise<Next> {
	const rec = await loadItem(ctx, s);
	if (!rec) {
		Object.assign(s, { msg: `CUS1915E ${noun(s)} ${s.id} NOT FOUND`, errField: "id" });
		return s;
	}
	return Object.assign(s, { mode: "update", version: rec.version, vals: undefined });
}

const titles = { T: { inquiry: "TRUCK", update: "UPDATE TRUCK", add: "ADD A TRUCK" }, D: { inquiry: "DRIVER", update: "UPDATE DRIVER", add: "ADD A DRIVER" } };

export const fleetitem: Program<FleetItemState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, s.kind === "T" ? "CUSF02" : "CUSF04");
		header(scr, ctx, titles[s.kind][s.mode]);
		const rec = s.mode === "add" ? undefined : await loadItem(ctx, s);
		let msg = s.msg ?? "";
		if (s.mode !== "add" && !rec && !msg) msg = `CUS1915E ${noun(s)} ${s.id ?? ""} NOT FOUND`;
		const editing = s.mode !== "inquiry";

		label(scr, 4, 4, dots(noun(s) + " NUMBER", 19));
		if (s.mode === "add") scr.input(4, 25, 8, "id", s.vals?.id ?? "", { bright: s.errField === "id" });
		else scr.text(4, 25, s.id ?? "", { color: "white", bright: true });

		if (rec || s.mode === "add") {
			defs(s).forEach((f, i) => {
				const row = 6 + i;
				label(scr, row, 4, dots(f.label, 19));
				const v = s.vals ? (s.vals[f.name] ?? "") : rec ? String((rec as unknown as Record<string, unknown>)[f.name] ?? "") : "";
				if (editing) scr.input(row, 25, f.len, f.name, v, { numeric: f.numeric, bright: s.errField === f.name });
				else value(scr, row, 25, f.name === "status" ? (s.kind === "T" ? truckStatusNames : driverStatusNames)[v] ?? v : v);
				if (f.hint && editing) scr.text(row, 26 + f.len + 1, f.hint, { color: "blue" });
			});
			if (rec) {
				const row = 7 + defs(s).length;
				label(scr, row, 4, dots("LAST UPDATED", 19));
				value(scr, row, 25, `${stamp(ctx, rec.updated)} BY ${rec.updated_by}`);
				if (!editing) await facts(ctx, scr, s, rec, row + 2);
			}
		}
		message(scr, msg);
		keys(scr, editing
			? "ENTER=SAVE  PF1=HELP  PF3=EXIT  PF12=CANCEL"
			: `PF1=HELP  PF3=EXIT  PF4=UPDATE${s.kind === "T" ? "  PF5=SERVICED" : ""}  PF12=CANCEL`);
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.mode === "add") scr.cursorTo("id");
		else if (editing) scr.cursorTo("name");
		return scr;
	},

	locks: (s) => (s.mode === "update" && s.id ? [`${noun(s)} ${s.id}`] : []),
	unlocked: (s) => ({ ...s, mode: "inquiry", vals: undefined }),

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		if (s.mode === "inquiry") {
			switch (input.aid) {
				case "ENTER":
					return s;
				case pf(3):
				case pf(12):
					return s.back;
				case pf(4):
					return openUpdate(ctx, s);
				case pf(5):
					if (s.kind !== "T" || !s.id) break;
					try {
						const t = await truckServiced(ctx.db, ctx.user, s.id);
						s.msg = `CUS1911I TRUCK ${t.id} SERVICED - NEXT DUE AT ${t.service_miles} MI OR ${t.service_due}`;
					} catch (e) {
						s.msg = isCode(e, "invalid") ? `CUS1912E ${e.message.toUpperCase()}` : fail(e);
					}
					return s;
			}
			s.msg = invalidKey(input.aid);
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
				return s.back;
			case pf(12):
				if (s.mode === "add") return s.back;
				return Object.assign(s, { mode: "inquiry", vals: undefined, msg: "CUS1916I UPDATE CANCELLED, NO CHANGES MADE" });
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const vals: Record<string, string> = { id: s.mode === "add" ? (input.fields.id ?? "").trim().toUpperCase() : s.id ?? "" };
		for (const f of defs(s)) vals[f.name] = (input.fields[f.name] ?? "").trim();
		s.vals = vals;
		if (s.mode === "update" && input.modified.size === 0) {
			s.msg = "CUS0406W NO FIELDS WERE CHANGED";
			return s;
		}
		try {
			const version = s.mode === "add" ? 0 : s.version ?? 0;
			const saved = s.kind === "T"
				? await saveTruck(ctx.db, ctx.user, parseTruck(vals), version)
				: await saveDriver(ctx.db, ctx.user, parseDriver(vals), version);
			const verb = s.mode === "add" ? "ADDED" : "UPDATED";
			return Object.assign(s, { id: saved.id, mode: "inquiry", vals: undefined, version: undefined, msg: `CUS1917I ${noun(s)} ${saved.id} ${verb}` });
		} catch (e) {
			if (isCode(e, "invalid")) {
				s.errField = e.field;
				s.msg = `CUS1918E ${e.message.toUpperCase()}`;
			} else if (isCode(e, "conflict")) {
				const rec = await loadItem(ctx, s);
				s.version = rec?.version;
				s.vals = undefined;
				s.msg = `CUS1919E ${noun(s)} ${s.id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
			} else {
				s.msg = fail(e);
			}
			return s;
		}
	},
};

// facts are what the system knows about a truck or driver beyond its
// record, from a row down: service, hours and today's load.
async function facts(ctx: Ctx, scr: Screen, s: FleetItemState, rec: Truck | Driver, row: number): Promise<void> {
	const day = freightDay();
	const today = (await todaysLoads(ctx)).get(`${s.kind}:${rec.id}`);
	const line = (text: string, v: string, color: Color = "white", bright = false) => {
		label(scr, row, 4, dots(text, 19));
		scr.text(row++, 25, v, { color, bright });
	};
	if (s.kind === "T") {
		const t = rec as Truck;
		const st = t.status === "R" ? "" : serviceState(t, day);
		if (st) {
			const left = t.service_miles > 0 ? `, ${Math.max(t.service_miles - t.odometer, 0)} MI TO GO` : "";
			line("SERVICE", st === "DUE" ? "** DUE NOW **" : st === "SOON" ? `DUE SOON${left}` : `OK${left}`,
				st === "DUE" ? "red" : st === "SOON" ? "yellow" : "green", st !== "OK");
		}
		const r = await ctx.db.prepare(
			"SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'C' THEN actual_miles ELSE 0 END), 0) AS mi FROM loads WHERE truck_id = ? AND day BETWEEN ? AND ?",
		).bind(t.id, addDays(day, -29), day).first<{ n: number; mi: number }>();
		line("LAST 30 DAYS", `${r!.n} LOADS, ${r!.mi} MI`);
	} else {
		const d = rec as Driver;
		const used = await dutyMinutes(ctx.db, d.id, day);
		line("ON DUTY, 7 DAYS", `${hours(used)} OF ${WEEK_DUTY_MIN / 60}:00`, used > WEEK_DUTY_MIN - 8 * 60 ? "yellow" : "white");
		if (d.cdl_expires < day) line("LICENSE", "*** EXPIRED ***", "red", true);
		else if (d.cdl_expires < addDays(day, 30)) line("LICENSE", "*** EXPIRES SOON ***", "yellow", true);
	}
	line("TODAY", today ?? "NO LOAD", today ? "white" : "blue");
}

export function newFleet(back: State, kind: "T" | "D"): TrucksState | DriversState {
	return kind === "T" ? { p: "trucks", back } : { p: "drivers", back };
}
