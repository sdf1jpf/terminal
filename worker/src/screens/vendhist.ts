import { vendorEvents, type VendorEvent } from "../events";
import { getPO, getVendor, type Vendor } from "../purchasing";
import { vendorID } from "./purchasing";
import { header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type Next, type Program, type State, type VendHistState } from "./program";

// CUSV04 VENDOR HISTORY is a vendor's event history, numbered and newest
// first: purchase orders opened, sent and received in full, each receipt of
// goods, and the EDI interchanges with the vendor's system. A PO number
// narrows it to one purchase order. Typing a line number opens the PO the
// event concerns (CUSV02), or the interchange's X12 (CUSE02).

const rowsFor = (ctx: Ctx) => ctx.rows - 13;

function eventLine(n: string, date: string, time: string, event: string, text: string, amount: string, user: string): string {
	return `${lpad(n, 3)} ${pad(date, 10)} ${pad(time, 5)} ${pad(event, 8)} ${pad(text, 26)} ${lpad(amount, 11)} ${pad(user, 8)}`;
}

const colors: Record<string, Color> = {
	OPENED: "white", SENT: "turquoise", RECEIPT: "green", RECEIVED: "green", "EDI IN": "blue", "EDI OUT": "blue",
};

// poID reads a typed purchase order number: PO00001, or just 1.
export function poID(typed: string): string {
	const v = typed.trim().toUpperCase();
	if (/^(PO)?\d{1,5}$/.test(v)) return "PO" + v.replace(/^PO/, "").padStart(5, "0");
	return v;
}

export function newVendHist(back: State, vendor = "", po = ""): VendHistState {
	return { p: "vendhist", back, vendor: vendor.trim() ? vendorID(vendor) : "", po: po.trim() ? poID(po) : "" };
}

async function vendor(ctx: Ctx, id: string): Promise<Vendor | undefined> {
	if (!id) return undefined;
	try {
		return await getVendor(ctx.db, id);
	} catch (e) {
		if (isCode(e, "not_found")) return undefined;
		throw e;
	}
}

async function events(ctx: Ctx, s: VendHistState): Promise<VendorEvent[]> {
	return s.vendor ? vendorEvents(ctx.db, s.vendor, s.po ?? "") : [];
}

export const vendhist: Program<VendHistState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSV04");
		header(scr, ctx, "VENDOR HISTORY");
		let msg = s.msg ?? "";
		const v = await vendor(ctx, s.vendor ?? "");
		if (s.vendor && !v && !msg) msg = `CUS0701E VENDOR ${s.vendor} NOT FOUND`;
		label(scr, 4, 2, "VENDOR NUMBER ====>");
		scr.input(4, 22, 6, "vendor", s.vendor ?? "", { bright: s.errField === "vendor" });
		if (v) {
			scr.text(4, 30, pad(`${v.name}  ${v.city}, ${v.state}`, 40), { color: "white", bright: true });
			if (v.status !== "A") scr.text(4, right(scr, 71), "INACTIVE", { color: "pink" });
		}
		label(scr, 5, 2, "PURCHASE ORDER ===>");
		scr.input(5, 22, 7, "po", s.po ?? "", { bright: s.errField === "po" });
		scr.text(5, 31, "BLANK FOR ALL OF THE VENDOR'S ORDERS", { color: "blue" });

		let list: VendorEvent[] = [];
		try {
			list = v ? await events(ctx, s) : [];
		} catch (e) {
			msg = fail(e);
		}
		if (v) {
			label(scr, 7, 2, "SHOW LINE ===>");
			scr.input(7, 17, 3, "line", "", { numeric: true, bright: s.errField === "line" });
			scr.text(7, 22, "TYPE A LINE NUMBER AND PRESS ENTER TO OPEN IT", { color: "blue" });
		}
		const rows = rowsFor(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(8, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(9, 2, eventLine("NO.", "DATE", "TIME", "EVENT", "DETAIL", "AT COST", "USER"), { color: "white", bright: true });
		scr.text(10, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((e, i) => {
			const [date, time] = stamp(ctx, e.at).split(" ");
			scr.text(11 + i, 2, eventLine(String(top + i + 1), date ?? "", time ?? "", e.event, e.text,
				e.amount === undefined ? "" : money(e.amount), e.by), { color: colors[e.event] ?? "green" });
		});
		if (v && list.length === 0 && !s.errField) scr.text(11, 4, s.po ? `NO EVENTS FOR ${s.po}` : "NO EVENTS ON FILE", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo(s.errField || (v ? "line" : "vendor"));
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		switch (input.aid) {
			case "ENTER": {
				const typedV = vendorID(input.fields.vendor ?? "");
				const typedPO = (input.fields.po ?? "").trim() ? poID(input.fields.po ?? "") : "";
				if (typedV !== (s.vendor ?? "") || typedPO !== (s.po ?? "")) {
					Object.assign(s, { vendor: typedV, po: typedPO, top: 0 });
					if (!typedV) {
						s.msg = "CUS0721E ENTER A VENDOR NUMBER";
						s.errField = "vendor";
					} else if (!(await vendor(ctx, typedV))) {
						s.msg = `CUS0701E VENDOR ${typedV} NOT FOUND`;
						s.errField = "vendor";
					} else if (typedPO) {
						const po = await getPO(ctx.db, typedPO).then((x) => x.po, () => undefined);
						if (!po || po.vendor_id !== typedV) {
							s.msg = `CUS0722E ${typedPO} IS NOT A PURCHASE ORDER FROM ${typedV}`;
							s.errField = "po";
						}
					}
					return s;
				}
				return showLine(ctx, s, (input.fields.line ?? "").trim());
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8): {
				const total = (await events(ctx, s)).length;
				const rows = rowsFor(ctx);
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

// showLine opens what the event on a line concerns.
async function showLine(ctx: Ctx, s: VendHistState, line: string): Promise<Next> {
	if (line === "") return s;
	const list = await events(ctx, s);
	const n = Number(line);
	if (!/^\d+$/.test(line) || n < 1 || n > list.length) {
		s.errField = "line";
		s.msg = list.length === 0 ? "CUS0246E THERE ARE NO EVENTS TO SHOW" : `CUS0246E LINE MUST BE 1 TO ${list.length}`;
		return s;
	}
	const e = list[n - 1];
	if (e.kind === "E") return { p: "edidoc", back: s, id: e.key };
	if (e.po && (await getPO(ctx.db, e.po).catch(() => undefined))) return { p: "po", back: s, id: e.po };
	s.errField = "line";
	s.msg = "CUS0247E THE EVENT IS NO LONGER ON FILE";
	return s;
}
