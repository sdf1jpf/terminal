import { createProduct, getProduct, listProducts, lowStock, parseProduct, updateProduct, type Product } from "../products";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, value, type Color, type Ctx, type Opts } from "./screen";
import { fail, isCode, pf, type Next, type ProductState, type ProductsState, type Program, type State } from "./program";

// CUSP01 PRODUCT LIST browses the product file with stock on hand, and
// CUSP02 PRODUCT shows, updates or adds one product. Low stock (an active
// product at or below its reorder point) shows in yellow, discontinued
// products in pink.

const listRows = (ctx: Ctx) => ctx.rows - 11;

function productColor(p: Product): Color {
	if (p.status === "D") return "pink";
	return lowStock(p) ? "yellow" : "green";
}

function listLine(sku: string, desc: string, price: string, onHand: string, reorder: string, status: string, flag: string): string {
	return `${pad(sku, 10)} ${pad(desc, 30)} ${lpad(price, 9)} ${lpad(onHand, 8)} ${lpad(reorder, 8)} ${pad(status, 2)} ${flag}`;
}

export const products: Program<ProductsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSP01");
		header(scr, ctx, "PRODUCT LIST");
		let msg = s.msg ?? "";
		let list: Product[] = [];
		try {
			list = await listProducts(ctx.db, s.filter ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "SKU STARTS WITH ===>");
		scr.input(4, 23, 10, "filter", s.filter ?? "");
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, "SELECT: S=SHOW  U=UPDATE", { color: "blue" });
		scr.text(7, 2, "S " + listLine("SKU", "DESCRIPTION", "PRICE", "ON HAND", "REORDER", "ST", ""), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((p, i) => {
			scr.input(9 + i, 2, 1, "sel:" + p.sku, "", { bright: s.errSel === p.sku });
			scr.text(9 + i, 4, listLine(p.sku, p.description, money(p.unit_price), String(p.on_hand), String(p.reorder_point),
				p.status, lowStock(p) ? "LOW" : ""), { color: productColor(p) });
		});
		if (list.length === 0) scr.text(9, 4, "NO PRODUCTS MATCH THE FILTER", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel && shown.some((p) => p.sku === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0 && !s.filter) scr.cursorTo("sel:" + shown[0].sku);
		else scr.cursorTo("filter");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		const filter = (input.fields.filter ?? "").trim().toUpperCase();
		if (input.aid === "ENTER" && filter !== (s.filter ?? "")) {
			s.filter = filter;
			s.top = 0;
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const sku = name.slice(4);
					if (code !== "S" && code !== "U") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = sku;
						return s;
					}
					const p = await loadProduct(ctx, { p: "product", mode: "inquiry", back: s }, sku);
					if (p.prod && code === "U") p.mode = "update";
					return p;
				}
				return s;
			case pf(3):
			case pf(12):
				return { p: "menu" };
			case pf(5):
				return newProduct(s);
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await listProducts(ctx.db, s.filter ?? "")).length;
				if (input.aid === pf(7)) {
					if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
					s.top = Math.max((s.top ?? 0) - rows, 0);
				} else if ((s.top ?? 0) + rows >= total) {
					s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				} else {
					s.top = Math.min((s.top ?? 0) + rows, total - rows);
				}
				return s;
			}
			case "CLEAR":
				s.filter = "";
				s.top = 0;
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

export function newProduct(back: State): ProductState {
	return { p: "product", mode: "add", back, prod: { status: "A" } as Product };
}

// loadProduct reads a product into s; s.prod is unset if it was not found.
export async function loadProduct(ctx: Ctx, s: ProductState, sku: string): Promise<ProductState> {
	sku = sku.trim().toUpperCase();
	s.vals = undefined;
	try {
		s.prod = await getProduct(ctx.db, sku);
	} catch (e) {
		s.prod = undefined;
		s.sku = sku;
		s.errField = "sku";
		s.msg = isCode(e, "not_found") ? `CUS0401E PRODUCT ${sku} NOT FOUND` : fail(e);
	}
	return s;
}

interface FieldDef {
	name: string;
	label: string;
	length: number;
	numeric?: boolean;
	get: (p: Product) => string;
}

const num = (n: number | undefined) => (n === undefined ? "" : String(n));

const fields: FieldDef[] = [
	{ name: "desc", label: "DESCRIPTION", length: 30, get: (p) => p.description ?? "" },
	{ name: "price", label: "UNIT PRICE", length: 7, numeric: true, get: (p) => num(p.unit_price) },
	{ name: "onhand", label: "QUANTITY ON HAND", length: 7, numeric: true, get: (p) => num(p.on_hand) },
	{ name: "reorder", label: "REORDER POINT", length: 7, numeric: true, get: (p) => num(p.reorder_point) },
	{ name: "status", label: "STATUS (A/D)", length: 1, get: (p) => p.status ?? "" },
];

const titles = { inquiry: "PRODUCT INQUIRY", update: "PRODUCT UPDATE", add: "ADD PRODUCT" };

// Each field's edit error has its own message number.
const messageIDs: Record<string, string> = {
	sku: "CUS0410E", desc: "CUS0411E", price: "CUS0412E", onhand: "CUS0413E", reorder: "CUS0414E", status: "CUS0415E",
};

const fieldMessage = (field: string, msg: string) => `${messageIDs[field] ?? "CUS0419E"} ${msg.toUpperCase()}`;

export const product: Program<ProductState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSP02");
		header(scr, ctx, titles[s.mode]);
		const p = s.prod;
		const editing = s.mode !== "inquiry";

		label(scr, 4, 4, dots("SKU", 19));
		if (s.mode === "update") scr.text(4, 25, p?.sku ?? "", { color: "white", bright: true });
		else scr.input(4, 25, 10, "sku", s.vals?.sku ?? p?.sku ?? s.sku ?? "", { bright: s.errField === "sku" });

		if (p) {
			fields.forEach((f, i) => {
				const row = 6 + i;
				label(scr, row, 4, dots(f.label, 19));
				const v = s.vals ? (s.vals[f.name] ?? "") : f.get(p);
				if (editing) {
					const opts: Opts = { numeric: f.numeric, bright: s.errField === f.name };
					scr.input(row, 25, f.length, f.name, v, opts);
				} else {
					value(scr, row, 25, f.name === "price" ? money(p.unit_price) : v);
				}
			});
			if (s.mode !== "add") {
				const col = right(scr, 58);
				if (lowStock(p)) scr.text(6, col, "*** LOW STOCK - REORDER ***", { color: "yellow", bright: true });
				if (p.status === "D") scr.text(6, col, "*** DISCONTINUED ***", { color: "pink", bright: true });
				label(scr, 8, col, "STOCK VALUE");
				scr.text(8, col + 12, lpad(money(p.unit_price * p.on_hand), 11), { color: "white" });
				label(scr, 12, 4, dots("LAST UPDATED", 19));
				value(scr, 12, 25, `${stamp(ctx, p.updated)} BY ${p.updated_by}`);
			}
		}

		message(scr, s.msg ?? "");
		keys(scr, editing
			? "ENTER=SAVE  PF1=HELP  PF3=EXIT  PF12=CANCEL"
			: "ENTER=DISPLAY  PF1=HELP  PF3=EXIT  PF4=UPDATE  PF12=CANCEL");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.mode === "update") scr.cursorTo("desc");
		else scr.cursorTo("sku");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		if (s.mode === "inquiry") return inquiry(ctx, s, input.aid, input.fields);
		return edit(ctx, s, input.aid, input.fields, input.modified);
	},
};

async function inquiry(ctx: Ctx, s: ProductState, aid: string, f: Record<string, string>): Promise<Next> {
	switch (aid) {
		case "ENTER": {
			const sku = (f.sku ?? "").trim();
			if (!sku) {
				Object.assign(s, { msg: "CUS0402E ENTER A SKU", errField: "sku", prod: undefined });
				return s;
			}
			await loadProduct(ctx, s, sku);
			if (s.prod) s.msg = `CUS0403I PRODUCT ${s.prod.sku} DISPLAYED`;
			return s;
		}
		case pf(3):
		case pf(12):
			return s.back;
		case pf(4):
			if (!s.prod) {
				Object.assign(s, { msg: "CUS0404E DISPLAY A PRODUCT FIRST", errField: "sku" });
				return s;
			}
			await loadProduct(ctx, s, s.prod.sku); // the latest copy
			if (s.prod) s.mode = "update";
			return s;
	}
	s.msg = invalidKey(aid);
	return s;
}

async function edit(ctx: Ctx, s: ProductState, aid: string, f: Record<string, string>, modified: Set<string>): Promise<Next> {
	switch (aid) {
		case "ENTER":
			break;
		case pf(3):
			return s.back;
		case pf(12):
			if (s.mode === "add") return s.back;
			Object.assign(s, { mode: "inquiry", vals: undefined, msg: "CUS0405I UPDATE CANCELLED, NO CHANGES MADE" });
			return s;
		default:
			s.msg = invalidKey(aid);
			return s;
	}

	const vals: Record<string, string> = { sku: f.sku ?? s.prod?.sku ?? "" };
	for (const fd of fields) vals[fd.name] = f[fd.name] ?? "";
	s.vals = vals;
	if (s.mode === "update" && modified.size === 0) {
		s.msg = "CUS0406W NO FIELDS WERE CHANGED";
		return s;
	}
	for (const [name, what] of [["price", "unit price"], ["onhand", "quantity on hand"], ["reorder", "reorder point"]]) {
		if (!/^\d+$/.test(vals[name].trim())) {
			s.errField = name;
			s.msg = fieldMessage(name, `${what} must be a whole, positive number`);
			return s;
		}
	}
	const sku = s.mode === "update" ? s.prod!.sku : vals.sku;
	try {
		const { fields: edit, version } = parseProduct({
			sku, description: vals.desc, unit_price: Number(vals.price), on_hand: Number(vals.onhand),
			reorder_point: Number(vals.reorder), status: vals.status, version: s.prod?.version ?? 0,
		});
		const saved = s.mode === "add"
			? await createProduct(ctx.db, edit, ctx.user)
			: await updateProduct(ctx.db, sku, edit, version, ctx.user);
		const verb = s.mode === "add" ? "ADDED" : "UPDATED";
		Object.assign(s, { prod: saved, vals: undefined, mode: "inquiry", msg: `CUS0407I PRODUCT ${saved.sku} ${verb}` });
	} catch (e) {
		if (isCode(e, "invalid")) {
			s.errField = e.field;
			s.msg = fieldMessage(e.field ?? "", e.message);
		} else if (isCode(e, "conflict")) {
			await loadProduct(ctx, s, sku);
			if (s.prod) s.msg = `CUS0408E ${sku} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
		} else if (isCode(e, "not_found")) {
			Object.assign(s, { mode: "inquiry", prod: undefined, vals: undefined, sku, errField: "sku", msg: `CUS0401E PRODUCT ${sku} NOT FOUND` });
		} else {
			s.msg = fail(e);
		}
	}
	return s;
}
