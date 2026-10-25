import { listCustomers, type Search } from "../data";
import type { Customer } from "../customer";
import { newActivity, newHistory } from "./activity";
import { loadDetail, newAdd } from "./detail";
import { newInvoices } from "./invoices";
import { header, invalidKey, keys, label, message, MIN_COLS, money, newScreen, pad, lpad, right, type Ctx, type Color } from "./screen";
import { fail, pf, type BrowseState, type Mode, type Program } from "./program";

// A scrollable list of customers with a selection column, in the style of
// an ISPF member list. Each selection field is named after the customer it
// is next to ("sel:000101"), so the commarea need not remember the page.

// pageRows is how many customers fit between the column headings and the
// message line: 13 on a 24x80 screen.
export function pageRows(ctx: Ctx): number {
	return ctx.rows - 11;
}

const codes: Record<string, Mode> = { S: "inquiry", U: "update", D: "delete" };

function search(b: BrowseState): Search {
	return { city: b.city, state: b.state, status: b.status };
}

// The search fields, and where each one's value lives in the state.
const searchFields = ["filter", "city", "state", "status"] as const;

export const browse: Program<BrowseState> = {
	async render(ctx, b) {
		const scr = newScreen(ctx, "CUSM01");
		header(scr, ctx, "CUSTOMER BROWSE");

		let list: Customer[] = [];
		let msg = b.msg ?? "";
		try {
			list = await listCustomers(ctx.db, b.filter ?? "", search(b));
		} catch (e) {
			msg = fail(e);
		}
		const page = pageRows(ctx);
		const top = Math.min(b.top ?? 0, Math.max(list.length - page, 0));
		// A wider screen gives the extra columns to the name and city.
		const extra = scr.cols - MIN_COLS;
		const nameW = 24 + Math.floor((extra * 3) / 5);
		const cityW = 15 + extra - Math.floor((extra * 3) / 5);

		label(scr, 4, 2, "NAME STARTS WITH ===>");
		scr.input(4, 24, 20, "filter", b.filter ?? "");
		label(scr, 6, 2, "CITY ===>");
		scr.input(6, 12, 18, "city", b.city ?? "");
		label(scr, 6, 32, "STATE ===>");
		scr.input(6, 43, 2, "state", b.state ?? "", { bright: b.errField === "state" });
		label(scr, 6, 47, "STATUS ===>");
		scr.input(6, 59, 1, "status", b.status ?? "", { bright: b.errField === "status" });
		scr.text(6, 62, "A/H/C", { color: "blue" });
		if (list.length > 0) {
			const end = Math.min(top + page, list.length);
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${end} OF ${list.length}`, { color: "white" });
		}

		scr.text(5, 2, "SELECT: S=SHOW  U=UPDATE  D=DELETE  A=ACTIVITY  H=HISTORY  I=INVOICES", { color: "blue" });
		scr.text(7, 2, `S CUST NO  ${pad("NAME", nameW)} ${pad("CITY", cityW)} ST      BALANCE STAT`,
			{ color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });

		const shown = list.slice(top, top + page);
		shown.forEach((c, i) => {
			const row = 9 + i;
			scr.input(row, 2, 1, "sel:" + c.id, "", { bright: b.errSel === c.id });
			const color: Color = c.status === "H" ? "yellow" : c.status === "C" ? "pink" : "green";
			scr.text(row, 4, `${pad(c.id, 8)} ${pad(c.name, nameW)} ${pad(c.city, cityW)} ${pad(c.state, 2)} ${lpad(money(c.balance), 12)} ${c.status}`,
				{ color });
		});
		if (list.length === 0) {
			scr.text(9, 4, "NO CUSTOMERS MATCH THE SEARCH", { color: "yellow" });
		} else if (top + page >= list.length) {
			const stars = "*".repeat(Math.floor((scr.cols - 20) / 2));
			scr.text(9 + shown.length, 4, stars + " BOTTOM OF DATA " + stars, { color: "blue" });
		}

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN  PF12=CANCEL");
		const searching = searchFields.some((f) => b[f]);
		if (b.errField) {
			scr.cursorTo(b.errField);
		} else if (b.errSel && shown.some((c) => c.id === b.errSel)) {
			scr.cursorTo("sel:" + b.errSel);
		} else if (shown.length > 0 && !searching) {
			scr.cursorTo("sel:" + shown[0].id);
		} else {
			scr.cursorTo("filter");
		}
		return scr;
	},

	async handle(ctx, b, input) {
		b.msg = "";
		b.errSel = b.errField = undefined;
		const typed = Object.fromEntries(searchFields.map((f) => [f, (input.fields[f] ?? "").trim().toUpperCase()]));
		if (input.aid === "ENTER" && searchFields.some((f) => typed[f] !== (b[f] ?? ""))) {
			for (const f of searchFields) b[f] = typed[f];
			b.top = 0;
			if (b.state && !/^[A-Z]{2}$/.test(b.state)) {
				b.msg = "CUS0104E STATE MUST BE A TWO LETTER CODE";
				b.errField = "state";
			} else if (b.status && !["A", "H", "C"].includes(b.status)) {
				b.msg = "CUS0105E STATUS MUST BE A (ACTIVE), H (HOLD) OR C (CLOSED)";
				b.errField = "status";
			}
			return b;
		}
		const page = pageRows(ctx);
		switch (input.aid) {
			case "ENTER": {
				// Enter with nothing selected shows the list again, re-read.
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const id = name.slice(4);
					if (code === "A") return newActivity(ctx, b, id);
					if (code === "H") return newHistory(ctx, b, id);
					if (code === "I") return newInvoices(b, id);
					const mode = codes[code];
					if (!mode) {
						b.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						b.errSel = id;
						return b;
					}
					const d = await loadDetail(ctx, { p: "detail", mode, back: b }, id);
					if (!d.loaded) d.mode = "inquiry";
					return d;
				}
				return b;
			}
			case pf(3):
			case pf(12):
				return { p: "menu" };
			case pf(5):
				return newAdd(b);
			case pf(7):
				if (!b.top) b.msg = "CUS0101W ALREADY AT TOP OF DATA";
				b.top = Math.max((b.top ?? 0) - page, 0);
				return b;
			case pf(8): {
				let count = 0;
				try {
					count = (await listCustomers(ctx.db, b.filter ?? "", search(b))).length;
				} catch (e) {
					b.msg = fail(e);
					return b;
				}
				const top = Math.min(b.top ?? 0, Math.max(count - page, 0));
				if (top + page >= count) {
					b.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
					b.top = top;
				} else {
					b.top = Math.min(top + page, count - page); // keep the last page full
				}
				return b;
			}
			case "CLEAR":
				for (const f of searchFields) b[f] = "";
				b.top = 0;
				return b;
		}
		b.msg = invalidKey(input.aid);
		return b;
	},
};
