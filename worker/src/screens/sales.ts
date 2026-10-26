import { getCustomer } from "../data";
import type { Customer } from "../customer";
import { spoolReport } from "../spool";
import {
	assign, assignment, customerCounts, deletePricing, deleteTerritory, listPricing, listSalespeople, listTerritories, pct,
	salesBy, saveSalesperson, saveTerritory, setPricing, terms, type Assignment, type Pricing, type SalesRow,
} from "../sales";
import { padID } from "./detail";
import { dots, header, invalidKey, keys, label, lpad, message, MIN_COLS, money, newScreen, pad, right, stamp, textLines, value, type Ctx } from "./screen";
import {
	fail, isCode, pf, type Next, type PricingState, type Program, type SalesRptState, type SalespeopleState, type State, type TerritoriesState,
} from "./program";

// The SALES menu's panels (sales.ts has the rules):
//
// CUSC01 CUSTOMER PRICING shows who sells to a customer, which can be
// changed, and its pricing agreements: discounts off list or contract
// prices, for a SKU, a product line or * for everything.
// CUSG01 SALES TERRITORIES lists the territories with their salesperson
// and states; CUSG02 SALESPEOPLE lists the salespeople with their
// commission rates. Both have an entry line at the top to add or change one,
// which U fills from a row.
// CUSG03 SALES BY TERRITORY or BY SALESPERSON totals a month's billed
// invoices, with discounts given and commission earned.

const bad = (id: string, e: unknown) => (isCode(e, "invalid") || isCode(e, "not_found") ? `${id} ${(e as Error).message.toUpperCase()}` : fail(e));
const errField = (e: unknown) => (e as { field?: string }).field;

// ---- CUSC01 CUSTOMER PRICING ----

export function newPricing(back: State, cust = ""): PricingState {
	return { p: "pricing", back, cust: cust.trim() ? padID(cust) : "" };
}

const pricingRows = (ctx: Ctx) => ctx.rows - 14;

async function appliesTo(ctx: Ctx, list: Pricing[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (list.length === 0) return out;
	const { results } = await ctx.db.prepare("SELECT sku, description FROM products").all<{ sku: string; description: string }>();
	for (const p of list) {
		if (p.item === "*") out.set(p.item, "EVERY PRODUCT");
		else if (p.item.includes("-")) out.set(p.item, results.find((r) => r.sku === p.item)?.description ?? "(NOT ON FILE)");
		else {
			const n = results.filter((r) => r.sku.split("-")[0] === p.item).length;
			out.set(p.item, `PRODUCT LINE, ${n} SKU${n === 1 ? "" : "S"}`);
		}
	}
	return out;
}

export const pricing: Program<PricingState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSC01");
		header(scr, ctx, "CUSTOMER PRICING");
		let msg = s.msg ?? "";
		let cust: Customer | undefined;
		let who: Assignment | undefined;
		let list: Pricing[] = [];
		if (s.cust) {
			try {
				cust = await getCustomer(ctx.db, s.cust);
				who = await assignment(ctx.db, s.cust);
				list = await listPricing(ctx.db, s.cust);
			} catch (e) {
				msg ||= isCode(e, "not_found") ? `CUS0601E CUSTOMER ${s.cust} NOT FOUND` : fail(e);
			}
		}
		label(scr, 4, 4, "CUSTOMER ===>");
		scr.input(4, 18, 6, "cust", s.cust ?? "", { bright: s.errField === "cust" });
		if (cust) value(scr, 4, 26, `${cust.name}  ${cust.city}, ${cust.state}`.slice(0, scr.cols - 27));

		if (cust && who) {
			label(scr, 5, 4, "TERRITORY ===>");
			scr.input(5, 19, 4, "terr", s.vals?.terr ?? cust.territory ?? "", { bright: s.errField === "terr" });
			scr.text(5, 25, `${who.territory || "NONE"} ${who.territory_name}`.trim() + (who.territory_assigned ? " - ASSIGNED" : ` - BY STATE ${cust.state}`),
				{ color: "green" });
			label(scr, 6, 4, "SALESREP  ===>");
			scr.input(6, 19, 3, "rep", s.vals?.rep ?? cust.salesperson ?? "", { bright: s.errField === "rep" });
			scr.text(6, 25, `${who.salesperson} ${who.salesperson_name}`.trim() + (who.salesperson_assigned ? " - ASSIGNED" : " - TERRITORY'S"),
				{ color: "green" });

			label(scr, 8, 4, "ADD:  ITEM ===>");
			scr.input(8, 20, 10, "item", s.vals?.item ?? "", { bright: s.errField === "item" });
			label(scr, 8, 32, "DISC % ===>");
			scr.input(8, 44, 5, "disc", s.vals?.disc ?? "", { bright: s.errField === "disc" });
			label(scr, 8, 51, "OR PRICE ===>");
			scr.input(8, 65, 9, "price", s.vals?.price ?? "", { bright: s.errField === "price" });
			scr.text(9, 2, "SELECT: D=DELETE   ITEM IS A SKU, A PRODUCT LINE SUCH AS BRG, OR * FOR ALL", { color: "blue" });

			const what = await appliesTo(ctx, list);
			const rows = pricingRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
			scr.text(10, 2, "S ITEM       TERMS           APPLIES TO                      UPDATED", { color: "white", bright: true });
			scr.text(11, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			list.slice(top, top + rows).forEach((p, i) => {
				scr.input(12 + i, 2, 1, `sel:${p.item}`, "", { bright: s.errSel === p.item });
				value(scr, 12 + i, 4, `${pad(p.item, 10)} ${pad(terms(p), 15)} ${pad(what.get(p.item) ?? "", 31)} ${stamp(ctx, p.updated).slice(0, 10)}`);
			});
			if (list.length === 0) scr.text(12, 4, "NO PRICING AGREEMENTS - THIS CUSTOMER PAYS LIST", { color: "yellow" });
			if (list.length > rows) scr.text(10, right(scr, 70), `${top + 1}-${Math.min(top + rows, list.length)}/${list.length}`, { color: "white" });
		} else {
			scr.text(6, 4, "ENTER A CUSTOMER NUMBER", { color: "blue" });
		}

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		const focus = s.errField ?? (s.errSel ? `sel:${s.errSel}` : cust ? "item" : "cust");
		scr.cursorTo(focus);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER":
				return applyPricing(ctx, s, input.fields);
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.vals = undefined;
				return s;
			case pf(7):
			case pf(8): {
				const total = s.cust ? (await listPricing(ctx.db, s.cust)).length : 0;
				s.top = scroll(ctx, s, input.aid, pricingRows(ctx), total);
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

function scroll(ctx: Ctx, s: { top?: number; msg?: string }, aid: string, rows: number, total: number): number {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		return Math.max((s.top ?? 0) - rows, 0);
	}
	if ((s.top ?? 0) + rows >= total) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
		return s.top ?? 0;
	}
	return Math.min((s.top ?? 0) + rows, total - rows);
}

async function applyPricing(ctx: Ctx, s: PricingState, f: Record<string, string>): Promise<Next> {
	const cust = padID(f.cust ?? "");
	if (cust !== (s.cust ?? "")) {
		s.cust = cust;
		s.vals = undefined;
		s.top = 0;
		return s;
	}
	if (!cust) {
		s.errField = "cust";
		s.msg = "CUS0600E ENTER A CUSTOMER NUMBER";
		return s;
	}
	const vals = { terr: (f.terr ?? "").trim().toUpperCase(), rep: (f.rep ?? "").trim().toUpperCase(),
		item: (f.item ?? "").trim().toUpperCase(), disc: (f.disc ?? "").trim(), price: (f.price ?? "").trim() };
	s.vals = vals;
	try {
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const item = name.slice(4);
			if (code !== "D") {
				s.errSel = item;
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				return s;
			}
			await deletePricing(ctx.db, ctx.user, cust, item);
			s.msg = `CUS0603I PRICING FOR ${item} DELETED`;
			return s;
		}
		const c = await getCustomer(ctx.db, cust);
		const done: string[] = [];
		if (vals.terr !== (c.territory ?? "") || vals.rep !== (c.salesperson ?? "")) {
			const who = await assign(ctx.db, ctx.user, cust, { territory: vals.terr, salesperson: vals.rep });
			done.push(`SOLD BY ${who.territory || "NO TERRITORY"}/${who.salesperson || "HOUSE"}`);
		}
		if (vals.item || vals.disc || vals.price) {
			const p = await setPricing(ctx.db, ctx.user, cust, vals);
			done.push(`${p.item} AT ${terms(p)}`);
			vals.item = vals.disc = vals.price = "";
		}
		s.vals = undefined;
		s.msg = done.length ? `CUS0602I ${cust} NOW ${done.join(", ")}` : "";
	} catch (e) {
		const field = errField(e);
		s.errField = field && field in vals ? field : "item";
		s.msg = bad("CUS0604E", e);
	}
	return s;
}

// ---- CUSG01 SALES TERRITORIES ----

const STATES_PER_ROW = 14;

export const territories: Program<TerritoriesState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSG01");
		header(scr, ctx, "SALES TERRITORIES");
		let msg = s.msg ?? "";
		let list: Awaited<ReturnType<typeof listTerritories>> = [];
		let counts = new Map<string, number>();
		let reps = new Map<string, string>();
		try {
			list = await listTerritories(ctx.db);
			counts = (await customerCounts(ctx.db)).territory;
			reps = new Map((await listSalespeople(ctx.db)).map((r) => [r.id, r.name]));
		} catch (e) {
			msg = fail(e);
		}
		label(scr, 4, 2, "CODE ===>");
		scr.input(4, 12, 4, "code", s.vals?.code ?? "", { bright: s.errField === "code" });
		label(scr, 4, 18, "NAME ===>");
		scr.input(4, 28, 20, "tname", s.vals?.tname ?? "", { bright: s.errField === "tname" });
		label(scr, 4, 50, "SALESREP ===>");
		scr.input(4, 64, 3, "trep", s.vals?.trep ?? "", { bright: s.errField === "trep" });
		if (s.vals?.trep && reps.has(s.vals.trep)) scr.text(4, 68, reps.get(s.vals.trep)!.slice(0, scr.cols - 69), { color: "green" });
		label(scr, 5, 2, "STATES ==>");
		scr.input(5, 13, scr.cols - 15, "states", s.vals?.states ?? "", { bright: s.errField === "states" });
		scr.text(6, 2, "SELECT: U=CHANGE  D=DELETE    ENTER A CODE ABOVE TO ADD OR CHANGE ONE", { color: "blue" });
		scr.text(8, 2, "S CODE NAME             REP  CUST  STATES", { color: "white", bright: true });
		scr.text(9, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		let row = 10;
		for (const t of list) {
			if (row > ctx.rows - 3) break;
			scr.input(row, 2, 1, `sel:${t.code}`, "", { bright: s.errSel === t.code });
			const color = s.confirm === t.code ? "red" : "turquoise";
			scr.text(row, 4, `${pad(t.code, 4)} ${pad(t.name, 16)} ${pad(t.salesperson || "-", 3)} ${lpad(counts.get(t.code) ?? 0, 5)}`, { color });
			const chunks = t.states.length ? [] as string[] : ["(NONE)"];
			for (let i = 0; i < t.states.length; i += STATES_PER_ROW) chunks.push(t.states.slice(i, i + STATES_PER_ROW).join(" "));
			for (const c of chunks) {
				if (row > ctx.rows - 3) break;
				scr.text(row++, 36, c, { color: "green" });
			}
		}
		const loose = counts.get("") ?? 0;
		if (loose > 0 && row <= ctx.rows - 3) scr.text(row, 4, `${loose} CUSTOMER${loose === 1 ? " IS" : "S ARE"} IN NO TERRITORY - HOUSE ACCOUNTS`, { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF12=CANCEL");
		scr.cursorTo(s.errField ?? (s.errSel ? `sel:${s.errSel}` : "code"));
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errField = s.errSel = s.confirm = undefined;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.vals = undefined;
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const f = input.fields;
		s.vals = { code: (f.code ?? "").trim().toUpperCase(), tname: (f.tname ?? "").trim().toUpperCase(),
			trep: (f.trep ?? "").trim().toUpperCase(), states: (f.states ?? "").trim().toUpperCase() };
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const terr = name.slice(4);
			const t = (await listTerritories(ctx.db)).find((x) => x.code === terr);
			if (!t) {
				s.msg = `CUS0611E TERRITORY ${terr} IS NO LONGER ON FILE`;
				return s;
			}
			if (code === "U") {
				s.vals = { code: t.code, tname: t.name, trep: t.salesperson, states: t.states.join(" ") };
				s.msg = `CUS0612I CHANGE ${t.code} ABOVE AND PRESS ENTER`;
				return s;
			}
			if (code === "D") {
				if (confirm !== terr) {
					s.confirm = s.errSel = terr;
					s.msg = `CUS0613W ENTER D AGAIN TO DELETE TERRITORY ${terr}`;
					return s;
				}
				try {
					await deleteTerritory(ctx.db, terr);
					s.msg = `CUS0614I TERRITORY ${terr} DELETED`;
				} catch (e) {
					s.errSel = terr;
					s.msg = bad("CUS0615E", e);
				}
				return s;
			}
			s.errSel = terr;
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			return s;
		}
		if (!s.vals.code && !s.vals.tname && !s.vals.trep && !s.vals.states) return s;
		try {
			const t = await saveTerritory(ctx.db, ctx.user, { code: s.vals.code, name: s.vals.tname, salesperson: s.vals.trep, states: s.vals.states });
			s.msg = `CUS0610I TERRITORY ${t.code} SAVED, ${t.states.length} STATE${t.states.length === 1 ? "" : "S"}`;
			s.vals = undefined;
		} catch (e) {
			s.errField = errField(e) ?? "code";
			s.msg = bad("CUS0615E", e);
		}
		return s;
	},
};

// ---- CUSG02 SALESPEOPLE ----

export const salespeople: Program<SalespeopleState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSG02");
		header(scr, ctx, "SALESPEOPLE");
		let msg = s.msg ?? "";
		let list: Awaited<ReturnType<typeof listSalespeople>> = [];
		let custs = new Map<string, number>();
		let terrs: Awaited<ReturnType<typeof listTerritories>> = [];
		try {
			list = await listSalespeople(ctx.db);
			custs = (await customerCounts(ctx.db)).salesperson;
			terrs = await listTerritories(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		label(scr, 4, 2, "ID ===>");
		scr.input(4, 10, 3, "sid", s.vals?.sid ?? "", { bright: s.errField === "sid" });
		label(scr, 4, 15, "NAME ===>");
		scr.input(4, 25, 24, "name", s.vals?.name ?? "", { bright: s.errField === "name" });
		label(scr, 4, 51, "COMM % ===>");
		scr.input(4, 63, 5, "comm", s.vals?.comm ?? "", { bright: s.errField === "comm" });
		label(scr, 5, 51, "STATUS ===>");
		scr.input(5, 63, 1, "status", s.vals?.status ?? "", { bright: s.errField === "status" });
		scr.text(5, 2, "LEAVE ID BLANK TO ADD ONE", { color: "blue" });
		scr.text(6, 2, "SELECT: U=CHANGE    STATUS A=ACTIVE I=INACTIVE", { color: "blue" });
		scr.text(8, 2, "S ID  NAME                     COMM   STATUS    CUST  TERRITORIES", { color: "white", bright: true });
		scr.text(9, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(0, ctx.rows - 12).forEach((r, i) => {
			scr.input(10 + i, 2, 1, `sel:${r.id}`, "", { bright: s.errSel === r.id });
			const covers = terrs.filter((t) => t.salesperson === r.id).map((t) => t.code).join(" ") || "-";
			scr.text(10 + i, 4, `${pad(r.id, 3)} ${pad(r.name, 24)} ${lpad(pct(r.comm_pct10), 5)}  ${pad(r.status === "A" ? "ACTIVE" : "INACTIVE", 8)} ${lpad(custs.get(r.id) ?? 0, 5)}  ${covers}`
				.slice(0, scr.cols - 5), { color: r.status === "A" ? "turquoise" : "pink" });
		});
		const house = custs.get("") ?? 0;
		if (house > 0) scr.text(ctx.rows - 2, 4, `${house} HOUSE ACCOUNT${house === 1 ? "" : "S"} WITH NO SALESPERSON`, { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF12=CANCEL");
		scr.cursorTo(s.errField ?? (s.errSel ? `sel:${s.errSel}` : "name"));
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = s.errSel = undefined;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.vals = undefined;
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const f = input.fields;
		s.vals = { sid: (f.sid ?? "").trim().toUpperCase(), name: (f.name ?? "").trim().toUpperCase(),
			comm: (f.comm ?? "").trim(), status: (f.status ?? "").trim().toUpperCase() };
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const id = name.slice(4);
			const r = (await listSalespeople(ctx.db)).find((x) => x.id === id);
			if (r && code === "U") {
				s.vals = { sid: r.id, name: r.name, comm: pct(r.comm_pct10).replace("%", ""), status: r.status };
				s.msg = `CUS0622I CHANGE ${r.id} ABOVE AND PRESS ENTER`;
				return s;
			}
			s.errSel = id;
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			return s;
		}
		if (!s.vals.sid && !s.vals.name && !s.vals.comm && !s.vals.status) return s;
		try {
			const r = await saveSalesperson(ctx.db, ctx.user, s.vals.sid, { name: s.vals.name, comm: s.vals.comm, status: s.vals.status });
			s.msg = `CUS0620I SALESPERSON ${r.id} ${r.name} SAVED, COMMISSION ${pct(r.comm_pct10)}`;
			s.vals = undefined;
		} catch (e) {
			s.errField = isCode(e, "not_found") ? "sid" : errField(e) ?? "name";
			s.msg = bad("CUS0621E", e);
		}
		return s;
	},
};

// ---- CUSG03 SALES BY TERRITORY / SALESPERSON ----

export const thisMonth = () => new Date().toISOString().slice(0, 7);

function shiftMonth(month: string, by: number): string {
	const [y, m] = month.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

type ReportRow = Pick<SalesRow, "key" | "name" | "invoices" | "discount" | "net" | "list" | "comm_pct10" | "commission">;

// reportLine lays out a row of the report, or with total its total line.
function reportLine(by: "T" | "S", r: ReportRow, total = false): string {
	const disc = r.list > 0 ? `${((r.discount * 100) / r.list).toFixed(1)}%` : "";
	const base = `${pad(total ? "" : r.key || "-", 4)} ${pad(r.name, 18)} ${lpad(r.invoices, 5)} ${lpad(money(r.discount), 11)} ${lpad(money(r.net), 12)} ${lpad(disc, 6)}`;
	return by === "S" ? `${base} ${lpad(r.key && !total ? pct(r.comm_pct10) : "", 5)} ${lpad(money(r.commission), 10)}` : base;
}

function reportHead(by: "T" | "S"): string {
	const base = `${pad(by === "T" ? "CODE" : "ID", 4)} ${pad("NAME", 18)} ${lpad("INVS", 5)} ${lpad("DISCOUNT", 11)} ${lpad("NET SALES", 12)} ${lpad("DISC%", 6)}`;
	return by === "S" ? `${base} ${lpad("COMM", 5)} ${lpad("COMMISSION", 10)}` : base;
}

export const salesrpt: Program<SalesRptState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSG03");
		header(scr, ctx, s.by === "T" ? "SALES BY TERRITORY" : "SALES BY SALESPERSON");
		let msg = s.msg ?? "";
		let rows: SalesRow[] = [];
		try {
			rows = await salesBy(ctx.db, s.by, s.month);
		} catch (e) {
			msg = fail(e);
		}
		label(scr, 4, 4, dots("MONTH BILLED", 14));
		scr.input(4, 20, 7, "month", s.month, { bright: s.errField === "month" });
		scr.text(4, 29, "YYYY-MM", { color: "blue" });
		const head = reportHead(s.by);
		scr.text(6, 2, head, { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(head.length), { color: "blue" });
		const shown = rows.slice(0, ctx.rows - 12);
		shown.forEach((r, i) => scr.text(8 + i, 2, reportLine(s.by, r), { color: r.invoices ? "turquoise" : "green" }));
		const total = rows.reduce((t, r) => ({
			...t, invoices: t.invoices + r.invoices, discount: t.discount + r.discount, net: t.net + r.net, list: t.list + r.list,
			commission: t.commission + r.commission,
		}), { key: "", name: "TOTAL", invoices: 0, discount: 0, net: 0, list: 0, comm_pct10: 0, commission: 0 });
		scr.text(8 + shown.length, 2, "-".repeat(head.length), { color: "blue" });
		scr.text(9 + shown.length, 2, reportLine(s.by, total, true), { color: "white", bright: true });

		message(scr, msg);
		keys(scr, `PF3=EXIT PF5=REFRESH PF6=${s.by === "T" ? "BY SALESPERSON" : "BY TERRITORY"} PF9=PRINT PF10=PREV PF11=NEXT`);
		scr.cursorTo(s.errField ?? "month");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		const month = (input.fields.month ?? s.month).trim();
		if (input.aid !== pf(3) && input.aid !== pf(12)) {
			if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
				s.errField = "month";
				s.msg = "CUS0630E MONTH MUST BE YYYY-MM, SUCH AS " + thisMonth();
				return s;
			}
			s.month = month;
		}
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case "ENTER":
			case pf(5):
				return s;
			case pf(6):
				s.by = s.by === "T" ? "S" : "T";
				return s;
			case pf(10):
				s.month = shiftMonth(s.month, -1);
				return s;
			case pf(11):
				s.month = shiftMonth(s.month, 1);
				return s;
			case pf(9): {
				const title = s.by === "T" ? "SALES BY TERRITORY" : "SALES BY SALESPERSON";
				const lines = textLines(await salesrpt.render({ ...ctx, rows: 24, cols: MIN_COLS }, { p: "salesrpt", by: s.by, month: s.month, back: s.back }));
				const id = await spoolReport(ctx.db, ctx.user, "CUSG03", `${title} ${s.month}`, lines);
				s.msg = `CUS0631I REPORT PRINTED TO THE SPOOL AS ${id} - SEE OPTION 5.4`;
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
