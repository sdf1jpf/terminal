import { getCustomer } from "../data";
import type { Customer } from "../customer";
import { spoolReport } from "../spool";
import {
	assign, assignment, customerCounts, deleteBreak, deletePricing, deletePromotion, deleteTerritory, listBreaks, listPricing,
	listPromotions, listSalespeople, listTerritories, pct, salesBy, saveSalesperson, savePromotion, saveTerritory, setBreak, setPricing,
	terms, today, type Assignment, type Pricing, type Promotion, type QtyBreak, type SalesRow,
} from "../sales";
import { padID } from "./detail";
import { dots, header, invalidKey, keys, label, lpad, message, MIN_COLS, money, newScreen, pad, right, stamp, textLines, value, type Ctx } from "./screen";
import {
	fail, isCode, pf, type BreaksState, type Next, type PricingState, type PromosState, type Program, type SalesRptState, type SalespeopleState, type State, type TerritoriesState,
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
// CUSC02 QUANTITY BREAKS and CUSC03 PROMOTIONS keep the discounts open to
// every customer: an extra percentage off a large line, and dated
// promotions (current ones in green, coming ones yellow, past ones blue).

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

// ---- CUSC02 QUANTITY BREAKS ----

const breakRows = (ctx: Ctx) => ctx.rows - 12;

export const breaks: Program<BreaksState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSC02");
		header(scr, ctx, "QUANTITY BREAKS");
		let msg = s.msg ?? "";
		let list: QtyBreak[] = [];
		try {
			list = await listBreaks(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		label(scr, 4, 2, "ITEM ===>");
		scr.input(4, 12, 10, "item", s.vals?.item ?? "", { bright: s.errField === "item" });
		label(scr, 4, 24, "QTY OR MORE ===>");
		scr.input(4, 41, 5, "qty", s.vals?.qty ?? "", { numeric: true, bright: s.errField === "qty" });
		label(scr, 4, 48, "EXTRA DISC % ===>");
		scr.input(4, 66, 5, "disc", s.vals?.disc ?? "", { bright: s.errField === "disc" });
		scr.text(5, 2, "A LINE OF THAT MANY OR MORE GETS THE EXTRA DISCOUNT AFTER THE CUSTOMER'S PRICE", { color: "blue" });
		scr.text(6, 2, "SELECT: U=CHANGE  D=DELETE    ITEM IS A SKU, A PRODUCT LINE OR *", { color: "blue" });
		scr.text(8, 2, "S ITEM       QTY OR MORE  EXTRA DISC  UPDATED     BY", { color: "white", bright: true });
		scr.text(9, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const rows = breakRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		list.slice(top, top + rows).forEach((b, i) => {
			const key = `${b.item}/${b.min_qty}`;
			scr.input(10 + i, 2, 1, `sel:${key}`, "", { bright: s.errSel === key });
			value(scr, 10 + i, 4, `${pad(b.item, 10)} ${lpad(b.min_qty, 11)}  ${lpad(pct(b.disc_pct10), 10)}  ${stamp(ctx, b.updated).slice(0, 10)}  ${b.updated_by}`);
		});
		if (list.length === 0) scr.text(10, 4, "NO QUANTITY BREAKS", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo(s.errField ?? (s.errSel ? `sel:${s.errSel}` : "item"));
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
			case pf(7):
			case pf(8):
				s.top = scroll(ctx, s, input.aid, breakRows(ctx), (await listBreaks(ctx.db)).length);
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const f = input.fields;
		s.vals = { item: (f.item ?? "").trim().toUpperCase(), qty: (f.qty ?? "").trim(), disc: (f.disc ?? "").trim() };
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const key = name.slice(4);
			const [item, qty] = key.split("/");
			const b = (await listBreaks(ctx.db)).find((x) => x.item === item && x.min_qty === Number(qty));
			if (!b) {
				s.msg = "CUS0641E THAT BREAK IS NO LONGER ON FILE";
				return s;
			}
			if (code === "U") {
				s.vals = { item: b.item, qty: String(b.min_qty), disc: pct(b.disc_pct10).replace("%", "") };
				s.msg = "CUS0642I CHANGE THE DISCOUNT ABOVE AND PRESS ENTER";
				return s;
			}
			if (code === "D") {
				await deleteBreak(ctx.db, b.item, b.min_qty);
				s.msg = `CUS0643I BREAK FOR ${b.item} AT ${b.min_qty} DELETED`;
				return s;
			}
			s.errSel = key;
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			return s;
		}
		if (!s.vals.item && !s.vals.qty && !s.vals.disc) return s;
		try {
			const b = await setBreak(ctx.db, ctx.user, s.vals as { item: string; qty: string; disc: string });
			s.msg = `CUS0640I ${b.item} AT ${b.min_qty} OR MORE NOW ${pct(b.disc_pct10)} EXTRA OFF`;
			s.vals = undefined;
		} catch (e) {
			s.errField = errField(e) ?? "item";
			s.msg = bad("CUS0644E", e);
		}
		return s;
	},
};

// ---- CUSC03 PROMOTIONS ----

const promoRows = (ctx: Ctx) => ctx.rows - 13;

export const promos: Program<PromosState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSC03");
		header(scr, ctx, "PROMOTIONS");
		let msg = s.msg ?? "";
		let list: Promotion[] = [];
		try {
			list = await listPromotions(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const v = s.vals ?? {};
		label(scr, 4, 2, "ID ===>");
		scr.input(4, 10, 5, "pid", v.pid ?? "", { bright: s.errField === "pid" });
		label(scr, 4, 17, "DESCRIPTION ===>");
		scr.input(4, 34, 30, "desc", v.desc ?? "", { bright: s.errField === "desc" });
		label(scr, 5, 2, "ITEM =>");
		scr.input(5, 10, 10, "item", v.item ?? "", { bright: s.errField === "item" });
		label(scr, 5, 22, "DISC % =>");
		scr.input(5, 32, 5, "disc", v.disc ?? "", { bright: s.errField === "disc" });
		label(scr, 5, 39, "OR PRICE =>");
		scr.input(5, 51, 9, "price", v.price ?? "", { bright: s.errField === "price" });
		label(scr, 6, 2, "FROM =>");
		scr.input(6, 10, 10, "starts", v.starts ?? "", { bright: s.errField === "starts" });
		label(scr, 6, 22, "TO =====>");
		scr.input(6, 32, 10, "ends", v.ends ?? "", { bright: s.errField === "ends" });
		scr.text(6, 44, "YYYY-MM-DD; LEAVE ID BLANK TO ADD", { color: "blue" });
		scr.text(7, 2, "SELECT: U=CHANGE  D=DELETE    THE LOWER OF THE PROMOTION AND THE CUSTOMER'S PRICE", { color: "blue" });
		scr.text(9, 2, "S ID    DESCRIPTION            ITEM       TERMS          FROM       TO", { color: "white", bright: true });
		scr.text(10, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const day = today();
		const rows = promoRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		list.slice(top, top + rows).forEach((p, i) => {
			scr.input(11 + i, 2, 1, `sel:${p.id}`, "", { bright: s.errSel === p.id });
			const color = s.confirm === p.id ? "red" : p.ends < day ? "blue" : p.starts > day ? "yellow" : "green";
			scr.text(11 + i, 4, `${pad(p.id, 5)} ${pad(p.description, 22)} ${pad(p.item, 10)} ${pad(p.price ? `$${p.price.toLocaleString("en-US")}` : `${pct(p.disc_pct10)} OFF`, 14)} ${p.starts.slice(2)} ${p.ends.slice(2)}`, { color });
		});
		if (list.length === 0) scr.text(11, 4, "NO PROMOTIONS", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo(s.errField ?? (s.errSel ? `sel:${s.errSel}` : "desc"));
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
			case pf(7):
			case pf(8):
				s.top = scroll(ctx, s, input.aid, promoRows(ctx), (await listPromotions(ctx.db)).length);
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const f = input.fields;
		const t = (k: string) => (f[k] ?? "").trim().toUpperCase();
		s.vals = { pid: t("pid"), desc: t("desc"), item: t("item"), disc: t("disc"), price: t("price"), starts: t("starts"), ends: t("ends") };
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const id = name.slice(4);
			const p = (await listPromotions(ctx.db)).find((x) => x.id === id);
			if (!p) {
				s.msg = `CUS0651E PROMOTION ${id} IS NO LONGER ON FILE`;
				return s;
			}
			if (code === "U") {
				s.vals = {
					pid: p.id, desc: p.description, item: p.item, disc: p.price ? "" : pct(p.disc_pct10).replace("%", ""),
					price: p.price ? String(p.price) : "", starts: p.starts, ends: p.ends,
				};
				s.msg = `CUS0652I CHANGE ${p.id} ABOVE AND PRESS ENTER`;
				return s;
			}
			if (code === "D") {
				if (confirm !== id) {
					s.confirm = s.errSel = id;
					s.msg = `CUS0653W ENTER D AGAIN TO DELETE PROMOTION ${id}`;
					return s;
				}
				await deletePromotion(ctx.db, id);
				s.msg = `CUS0654I PROMOTION ${id} DELETED`;
				return s;
			}
			s.errSel = id;
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			return s;
		}
		if (Object.values(s.vals).every((x) => x === "")) return s;
		try {
			const p = await savePromotion(ctx.db, ctx.user, s.vals.pid, {
				description: s.vals.desc, item: s.vals.item, disc: s.vals.disc, price: s.vals.price, starts: s.vals.starts, ends: s.vals.ends,
			});
			s.msg = `CUS0650I PROMOTION ${p.id} SAVED, ${p.starts} TO ${p.ends}`;
			s.vals = undefined;
		} catch (e) {
			s.errField = isCode(e, "not_found") ? "pid" : errField(e) ?? "desc";
			s.msg = bad("CUS0655E", e);
		}
		return s;
	},
};
