import { lowStock, searchProducts, type Product } from "../products";
import { header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, type Color, type Ctx } from "./screen";
import { fail, pf, type EdiExState, type InvoiceState, type Program, type SkuSearchState } from "./program";

// CUSI03 PRODUCT SEARCH finds a product to put on an invoice by SKU or
// description. Picking one with S carries its SKU back to the invoice's
// add line. Only active products are listed; low stock shows in yellow and
// products with none on hand in red.

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(sku: string, desc: string, price: string, onHand: string): string {
	return `${pad(sku, 10)} ${pad(desc, 30)} ${lpad(price, 9)} ${lpad(onHand, 8)}`;
}

function stockColor(p: Product): Color {
	if (p.on_hand === 0) return "red";
	return lowStock(p) ? "yellow" : "green";
}

// searchText is what to look for, from a typed SKU such as "GLV?" or "*BOLT".
export const searchText = (sku: string) => sku.replace(/[?*]/g, "").trim().toUpperCase();

export function newSkuSearch(back: InvoiceState | EdiExState, q: string, msg?: string, seq?: number): SkuSearchState {
	return { p: "skusearch", back, q: searchText(q), msg, ...(seq === undefined ? {} : { seq }) };
}

export const skusearch: Program<SkuSearchState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSI03");
		header(scr, ctx, "PRODUCT SEARCH");
		let msg = s.msg ?? "";
		let list: Product[] = [];
		try {
			list = await searchProducts(ctx.db, s.q);
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "SKU OR DESCRIPTION ===>");
		scr.input(4, 26, 20, "q", s.q);
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, s.back.p === "ediex" ? "SELECT: S=USE FOR THE HELD EDI LINE" : `SELECT: S=ADD TO INVOICE ${s.back.id}`, { color: "blue" });
		scr.text(7, 2, "S " + listLine("SKU", "DESCRIPTION", "PRICE", "ON HAND"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((p, i) => {
			scr.input(9 + i, 2, 1, "sel:" + p.sku, "", { bright: s.errSel === p.sku });
			scr.text(9 + i, 4, listLine(p.sku, p.description, money(p.unit_price), String(p.on_hand)), { color: stockColor(p) });
		});
		if (list.length === 0) scr.text(9, 4, "NO ACTIVE PRODUCTS MATCH - CHANGE THE SEARCH AND PRESS ENTER", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel && shown.some((p) => p.sku === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].sku);
		else scr.cursorTo("q");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		const q = searchText(input.fields.q ?? "");
		if (input.aid === "ENTER" && q !== s.q) {
			s.q = q;
			s.top = 0;
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const sku = name.slice(4);
					if (code !== "S") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = sku;
						return s;
					}
					if (s.back.p === "ediex") {
						const ex = s.back;
						ex.vals = { ...ex.vals, [`sku:${s.seq}`]: sku };
						ex.msg = `CUS0544I ${sku} SELECTED - PRESS ENTER TO PUT IT ON THE ORDER`;
						return ex;
					}
					const inv = s.back;
					inv.vals = { sku, qty: inv.vals?.qty ?? "" };
					inv.focus = "qty";
					inv.msg = `CUS0516I ${sku} SELECTED - ENTER A QUANTITY AND PRESS ENTER TO ADD IT`;
					return inv;
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await searchProducts(ctx.db, s.q)).length;
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
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
