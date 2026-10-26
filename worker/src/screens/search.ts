import { statusNames } from "../invoices";
import { poStatusNames } from "../purchasing";
import { AiError, describe, naturalSearch } from "../ai";
import { filterSearch, search as searchAll, hitTypes, MAX_PER_TYPE, type Hit, type HitType } from "../search";
import { shipStatusNames } from "../shipping";
import { newInquiry } from "./detail";
import { loadProduct } from "./products";
import { newPOs } from "./purchasing";
import { header, invalidKey, keys, label, message, newScreen, pad, right, type Color, type Ctx } from "./screen";
import { fail, pf, type Next, type Program, type SearchState, type State } from "./program";

// CUSF01 SEARCH finds anything by name or number: customers, invoices,
// purchase orders, shipments, vendors and products. S beside a hit opens
// it on its own panel, and PF3 there comes back to the search.
//
// A search in plain English (CUSTOMERS IN OHIO OVER THEIR CREDIT LIMIT)
// that matches no name or number, or any search starting with ?, goes to
// Workers AI, which turns it into a filter on one type of record (ai.ts).
// The filter is kept on the state, so paging does not ask again.

const listRows = (ctx: Ctx) => ctx.rows - 11;

const typeNames: Record<HitType, string> = {
	C: "CUSTOMER", I: "INVOICE", O: "PO", S: "SHIPMENT", V: "VENDOR", P: "PRODUCT",
};

const custStatus: Record<string, string> = { A: "ACTIVE", H: "HOLD", C: "CLOSED" };
const statuses: Record<HitType, Record<string, string>> = {
	C: custStatus, I: statusNames, O: poStatusNames, S: shipStatusNames,
	V: { A: "ACTIVE", I: "INACTIVE" }, P: { A: "ACTIVE", D: "DISC" },
};

function listLine(type: string, key: string, desc: string, status: string): string {
	return `${pad(type, 9)} ${pad(key, 10)} ${pad(desc, 44)} ${pad(status, 9)}`;
}

function hitColor(h: Hit): Color {
	const inactive = (h.type === "C" && h.status !== "A") || (h.type === "V" && h.status === "I") || (h.type === "P" && h.status === "D");
	return inactive ? "yellow" : "green";
}

export function newSearch(back: State, q = "", type = ""): SearchState {
	return { p: "search", back, q: q.toUpperCase(), type: type.toUpperCase() };
}

// find opens the search with q already searched, for FIND on a command line.
export async function find(ctx: Ctx, back: State, q: string): Promise<SearchState> {
	const s = newSearch(back, q);
	if (s.q) await resolve(ctx, s);
	return s;
}

async function hits(ctx: Ctx, s: SearchState): Promise<Hit[]> {
	if (s.filter) return filterSearch(ctx.db, s.filter, s.also);
	return searchAll(ctx.db, s.q ?? "", s.type ? [s.type as HitType] : []);
}

// resolve decides how to search for s.q: by name or number, or, when that
// finds nothing and it reads like a sentence, in plain English.
async function resolve(ctx: Ctx, s: SearchState): Promise<void> {
	s.filter = s.also = undefined;
	const q = s.q ?? "";
	const forced = q.startsWith("?");
	const text = q.replace(/^\?\s*/, "");
	if (!text) return;
	if (!forced && (!/\s/.test(text) || (await hits(ctx, s)).length > 0)) return;
	try {
		const hint = s.type ? `${hitTypes[s.type as HitType]}S: ` : "";
		const { filter, also } = await naturalSearch(ctx.env, hint + text.toLowerCase());
		if (s.type) filter.type = s.type as HitType;
		s.filter = filter;
		if (also.length > 0) s.also = also;
		s.msg = `CUS1003I SEARCHED FOR ${describe(filter)}`.slice(0, 79);
	} catch (e) {
		if (!(e instanceof AiError)) throw e;
		s.msg = forced
			? "CUS1004W PLAIN-ENGLISH SEARCH NOT AVAILABLE - SEARCH BY NAME OR NUMBER"
			: "";
	}
}

export const search: Program<SearchState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSF01");
		header(scr, ctx, "SEARCH");
		let msg = s.msg ?? "";
		let list: Hit[] = [];
		try {
			list = await hits(ctx, s);
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "SEARCH FOR ===>");
		scr.input(4, 18, scr.cols - 31, "q", s.q ?? "", { bright: s.errField === "q" });
		label(scr, 4, scr.cols - 13, "TYPE ===>");
		scr.input(4, scr.cols - 3, 1, "type", s.type ?? "", { bright: s.errField === "type" });
		scr.text(5, 2, "TYPE: C CUSTOMER  I INVOICE  O PURCHASE ORDER  S SHIPMENT  V VENDOR  P PRODUCT", { color: "blue" });
		scr.text(6, 2, "SELECT: S=SHOW", { color: "blue" });
		if (list.length > 0) {
			scr.text(6, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(7, 2, "S " + listLine("TYPE", "KEY", "DESCRIPTION", "STATUS"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((h, i) => {
			const name = `sel:${h.type}:${h.key}`;
			scr.input(9 + i, 2, 1, name, "", { bright: s.errSel === name });
			const status = statuses[h.type][h.status] ?? h.status;
			scr.text(9 + i, 4, listLine(typeNames[h.type], h.key, h.description, status), { color: hitColor(h) });
		});
		if (!s.q) {
			scr.text(9, 4, "TYPE A NAME OR NUMBER, SUCH AS ACME, 105, INV00012 OR BRG, AND PRESS ENTER", { color: "turquoise" });
		} else if (list.length === 0 && !msg) {
			scr.text(9, 4, "NOTHING MATCHES - CHANGE THE SEARCH AND PRESS ENTER", { color: "yellow" });
		}
		if (!msg && list.length > 0) {
			const capped = Object.keys(hitTypes).filter((t) => list.filter((h) => h.type === t).length >= MAX_PER_TYPE);
			if (capped.length > 0) msg = `CUS1002W ONLY THE FIRST ${MAX_PER_TYPE} OF EACH TYPE ARE LISTED - NARROW THE SEARCH`;
		}

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel && shown.some((h) => `sel:${h.type}:${h.key}` === s.errSel)) scr.cursorTo(s.errSel);
		else if (s.errField) scr.cursorTo(s.errField);
		else if (shown.length > 0 && s.q) scr.cursorTo(`sel:${shown[0].type}:${shown[0].key}`);
		else scr.cursorTo("q");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const q = (input.fields.q ?? "").trim().toUpperCase();
		const type = (input.fields.type ?? "").trim().toUpperCase();
		if (input.aid === "ENTER" && (q !== (s.q ?? "") || type !== (s.type ?? ""))) {
			s.q = q;
			s.type = type;
			s.top = 0;
			if (type && !(type in hitTypes)) {
				s.errField = "type";
				s.msg = `CUS1001E INVALID TYPE "${type}" - USE C, I, O, S, V OR P, OR LEAVE IT BLANK`;
				return s;
			}
			await resolve(ctx, s);
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					if (code !== "S") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = name;
						return s;
					}
					const [, t, key] = name.split(":");
					return open(ctx, s, t as HitType, key);
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await hits(ctx, s)).length;
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

// open shows a hit on the panel that owns it.
async function open(ctx: Ctx, s: SearchState, type: HitType, key: string): Promise<Next> {
	switch (type) {
		case "C":
			return newInquiry(ctx, s, key);
		case "I":
			return { p: "invoice", back: s, id: key };
		case "O":
			return { p: "po", back: s, id: key };
		case "S":
			return { p: "shipment", back: s, id: key };
		case "V":
			return newPOs(s, key);
		case "P":
			return loadProduct(ctx, { p: "product", mode: "inquiry", back: s }, key);
	}
	return s;
}
