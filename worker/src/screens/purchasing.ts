import { submitJob } from "../jobs";
import {
	addPOLine, cancelPO, createPO, deletePOLine, getPO, getVendor, listPOs, listVendors, poStatusNames, receivePO, sendPO,
	type POLine, type PurchaseOrder, type Vendor,
} from "../purchasing";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, value, type Color, type Ctx } from "./screen";
import { newVendHist } from "./vendhist";
import { fail, isCode, pf, type Next, type POState, type POsState, type Program, type State, type VendorsState } from "./program";

// CUSV01 PURCHASE ORDERS lists purchase orders, newest first, for one
// vendor or all, opens new ones and runs the reorder job (CUSREORD) and the
// vendor simulator (VENDSIM). CUSV02 PURCHASE ORDER builds an open PO, sends
// it to the vendor as an 850 and receives the goods into stock. CUSV03
// VENDOR LIST lists the vendors. PF5 on a PO, or H beside a vendor, shows
// the event history (CUSV04, vendhist.ts).

const statusColor = (status: string): Color =>
	status === "O" ? "white" : status === "T" ? "yellow" : status === "R" ? "green" : "turquoise";

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(id: string, vendor: string, status: string, origin: string, ship: string, total: string, created: string): string {
	return `${pad(id, 7)} ${pad(vendor, 6)} ${pad(status, 10)} ${pad(origin, 8)} ${pad(ship, 10)} ${lpad(total, 11)}  ${created}`;
}

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

// vendorID reads a typed vendor number: V00001, or just 1.
export function vendorID(typed: string): string {
	const v = typed.trim().toUpperCase();
	if (/^V?\d{1,5}$/.test(v)) return "V" + v.replace(/^V/, "").padStart(5, "0");
	return v;
}

async function vendor(ctx: Ctx, id: string): Promise<Vendor | undefined> {
	try {
		return await getVendor(ctx.db, id);
	} catch (e) {
		if (isCode(e, "not_found")) return undefined;
		throw e;
	}
}

export function newPOs(back: State, v = ""): POsState {
	return { p: "pos", back, vendor: v.trim() ? vendorID(v) : "" };
}

export const pos: Program<POsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSV01");
		header(scr, ctx, "PURCHASE ORDERS");
		let msg = s.msg ?? "";
		let list: PurchaseOrder[] = [];
		try {
			list = await listPOs(ctx.db, s.vendor ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "VENDOR ===>");
		scr.input(4, 14, 6, "vendor", s.vendor ?? "", { bright: s.errField === "vendor" });
		const v = s.vendor ? await vendor(ctx, s.vendor) : undefined;
		if (v) scr.text(4, 22, pad(`${v.name}  ${v.city}, ${v.state}`, 34), { color: "white", bright: true });
		if (list.length > 0) {
			scr.text(5, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, "SELECT: S=SHOW  R=RECEIVE ALL", { color: "blue" });
		scr.text(7, 2, "S " + listLine("PO", "VENDOR", "STATUS", "ORIGIN", "SHIP DATE", "TOTAL", "CREATED"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((po, i) => {
			scr.input(9 + i, 2, 1, "sel:" + po.id, "", { bright: s.errSel === po.id });
			scr.text(9 + i, 4, listLine(po.id, po.vendor_id, poStatusNames[po.status], po.origin, po.ship_date, money(po.total),
				stamp(ctx, po.created).slice(0, 10)), { color: statusColor(po.status) });
		});
		if (list.length === 0) {
			scr.text(9, 4, s.vendor ? "NO PURCHASE ORDERS FOR THIS VENDOR" : "NO PURCHASE ORDERS - PF6 REORDERS LOW STOCK", { color: "yellow" });
		}

		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF4=VENDORS PF5=NEW PO PF6=REORDER PF7/8=SCROLL PF10=VENDSIM");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.errSel && shown.some((po) => po.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		else scr.cursorTo("vendor");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const typed = (input.fields.vendor ?? "").trim();
		const v = typed ? vendorID(typed) : "";
		if (input.aid === "ENTER" && input.modified.has("vendor") && v !== (s.vendor ?? "")) {
			s.vendor = v;
			s.top = 0;
			if (v && !(await vendor(ctx, v))) {
				s.msg = `CUS0701E VENDOR ${v} NOT FOUND`;
				s.errField = "vendor";
			}
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, val] of Object.entries(input.fields)) {
					const code = val.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const id = name.slice(4);
					if (code === "S") return { p: "po", back: s, id };
					s.errSel = id;
					if (code !== "R") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						return s;
					}
					try {
						const { units } = await receivePO(ctx.db, ctx.user, id, "all");
						s.errSel = undefined;
						s.msg = `CUS0714I ${id} RECEIVED IN FULL - ${units} UNITS PUT IN STOCK`;
					} catch (e) {
						s.msg = isCode(e, "invalid") ? `CUS0715E ${e.message.toUpperCase()}` : fail(e);
					}
					return s;
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				return { p: "vendors", back: s };
			case pf(5): {
				const id = s.vendor || v;
				if (!id) {
					s.msg = "CUS0702E ENTER A VENDOR NUMBER FOR THE NEW PURCHASE ORDER";
					s.errField = "vendor";
					return s;
				}
				try {
					const po = await createPO(ctx.db, ctx.user, id);
					s.vendor = id;
					return { p: "po", back: s, id: po.id, msg: `CUS0703I PURCHASE ORDER ${po.id} OPENED FOR ${id}` };
				} catch (e) {
					s.msg = isCode(e, "invalid") ? `CUS0704E ${e.message.toUpperCase()}` : fail(e);
					s.errField = "vendor";
					return s;
				}
			}
			case pf(6):
			case pf(10): {
				const name = input.aid === pf(6) ? "CUSREORD" : "VENDSIM";
				try {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, name);
					s.msg = `$HASP100 ${name} ON INTRDR - ${job.id} SUBMITTED - PRESS ENTER IN A MOMENT`;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
			}
			case pf(7):
			case pf(8):
				scroll(s, input.aid, listRows(ctx), (await listPOs(ctx.db, s.vendor ?? "")).length);
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// ---- CUSV02 PURCHASE ORDER ----

const lineRows = (ctx: Ctx) => ctx.rows - 14;

// receivable reports whether goods can be received against a PO.
const receivable = (status: string) => status === "S" || status === "A" || status === "T";

const messageIDs: Record<string, string> = { sku: "CUS0710E", qty: "CUS0711E", rcv: "CUS0712E" };
const fieldMessage = (field: string, msg: string) => `${messageIDs[field.split(":")[0]] ?? "CUS0719E"} ${msg.toUpperCase()}`;

export const po: Program<POState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSV02");
		header(scr, ctx, "PURCHASE ORDER");
		let order: PurchaseOrder | undefined;
		let lines: POLine[] = [];
		let msg = s.msg ?? "";
		try {
			({ po: order, lines } = await getPO(ctx.db, s.id));
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS0705E PURCHASE ORDER ${s.id} NOT FOUND` : fail(e);
		}
		const open = order?.status === "O";
		const rcv = !!order && receivable(order.status);

		label(scr, 4, 4, dots("PO NUMBER", 12));
		scr.text(4, 18, s.id, { color: "white", bright: true });
		if (order) {
			scr.text(4, 27, poStatusNames[order.status], { color: statusColor(order.status), bright: true });
			const col = right(scr, 58);
			label(scr, 4, col, "TOTAL");
			scr.text(4, col + 6, lpad(money(order.total), 15), { color: "white", bright: true });

			const v = await vendor(ctx, order.vendor_id);
			label(scr, 5, 4, dots("VENDOR", 12));
			value(scr, 5, 18, `${order.vendor_id} ${v?.name ?? "(NOT ON FILE)"}`);
			if (order.ship_date) {
				label(scr, 5, col, "SHIP DATE");
				scr.text(5, col + 11, lpad(order.ship_date, 10), { color: "white" });
			}
			label(scr, 6, 4, dots("ORIGIN", 12));
			value(scr, 6, 18, order.origin || order.created_by);
			const when = [`OPENED ${stamp(ctx, order.created).slice(0, 10)}`];
			if (order.sent) when.push(`SENT ${stamp(ctx, order.sent).slice(0, 10)}`);
			if (order.received) when.push(`RCVD ${stamp(ctx, order.received).slice(0, 10)}`);
			scr.text(6, right(scr, 44), lpad(when.join("  "), 36), { color: "green" });

			if (open) {
				label(scr, 8, 4, "ADD LINE:  SKU ===>");
				scr.input(8, 24, 10, "sku", s.vals?.sku ?? "", { bright: s.errField === "sku" });
				label(scr, 8, 37, "QTY ===>");
				scr.input(8, 46, 5, "qty", s.vals?.qty ?? "", { numeric: true, bright: s.errField === "qty" });
				scr.text(9, 2, "SELECT: D=DELETE LINE", { color: "blue" });
			} else if (rcv) {
				scr.text(9, 2, "TYPE THE QUANTITY THAT CAME IN UNDER RCV AND PRESS ENTER, OR PF11 FOR ALL", { color: "blue" });
			}

			const rows = lineRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(10, 2, `S ${lpad("LN", 3)} ${pad("SKU", 10)} ${pad("DESCRIPTION", 24)}   QTY  RCVD   RCV    COST     AMOUNT`,
				{ color: "white", bright: true });
			scr.text(11, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			lines.slice(top, top + rows).forEach((l, i) => {
				const row = 12 + i;
				const color = l.received >= l.quantity ? "green" : statusColor(order!.status);
				if (open) scr.input(row, 2, 1, `sel:${l.line}`, "");
				scr.text(row, 4, `${lpad(l.line, 3)} ${pad(l.sku, 10)} ${pad(l.description, 24)}`, { color });
				scr.text(row, 44, lpad(l.quantity, 5), { color });
				scr.text(row, 50, lpad(l.received, 5), { color });
				if (rcv && l.received < l.quantity) {
					scr.input(row, 56, 5, `rcv:${l.line}`, s.vals?.[`rcv:${l.line}`] ?? "", { numeric: true, bright: s.errField === `rcv:${l.line}` });
				}
				scr.text(row, 62, lpad(money(l.unit_cost), 7), { color });
				scr.text(row, 70, lpad(money(l.quantity * l.unit_cost), 10), { color });
			});
			if (lines.length === 0) scr.text(12, 4, "NO LINES YET - ADD A PRODUCT THIS VENDOR SUPPLIES", { color: "yellow" });
			if (lines.length > rows) {
				scr.text(10, right(scr, 66), `${top + 1}-${Math.min(top + rows, lines.length)}/${lines.length}`, { color: "white" });
			}
		}

		message(scr, msg);
		keys(scr, open
			? "ENTER=APPLY PF1=HELP PF3=EXIT PF5=HISTORY PF7/8=SCROLL PF9=CANCEL PO PF10=SEND"
			: rcv
				? "ENTER=RECEIVE PF1=HELP PF3=EXIT PF5=HISTORY PF7/8=SCROLL PF11=RECEIVE ALL"
				: "PF1=HELP  PF3=EXIT  PF5=HISTORY  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errField && (open || rcv)) scr.cursorTo(s.errField);
		else if (open) scr.cursorTo("sku");
		else if (rcv) {
			const first = lines.find((l) => l.received < l.quantity);
			if (first) scr.cursorTo(`rcv:${first.line}`);
		}
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errField = s.confirm = undefined;
		// Lines change only while the PO is open; goods come in once it is sent.
		const status = await getPO(ctx.db, s.id).then(({ po }) => po.status, () => "");
		const allowed: Record<string, boolean> = {
			ENTER: status === "O" || receivable(status), PF9: status === "O", PF10: status === "O", PF11: receivable(status),
		};
		if (input.aid in allowed && !allowed[input.aid]) {
			s.msg = input.aid === "ENTER" ? undefined : invalidKey(input.aid);
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				return status === "O" ? apply(ctx, s, input.fields) : receiveTyped(ctx, s, input.fields);
			case pf(3):
			case pf(12):
				return back(s);
			case pf(7):
			case pf(8): {
				const { lines } = await getPO(ctx.db, s.id).catch(() => ({ lines: [] }));
				scroll(s, input.aid, lineRows(ctx), lines.length);
				return s;
			}
			case pf(5): {
				if (!status) break;
				// Back to the history this came from, rather than another copy.
				if (s.back.p === "vendhist") return s.back;
				const { po } = await getPO(ctx.db, s.id);
				return newVendHist(s, po.vendor_id, po.id);
			}
			case pf(9):
				if (!confirm) {
					s.confirm = true;
					s.msg = `CUS0706W PRESS PF9 AGAIN TO CANCEL PURCHASE ORDER ${s.id}`;
					return s;
				}
				return act(s, async () => {
					await cancelPO(ctx.db, s.id);
					return back(s, `CUS0707I PURCHASE ORDER ${s.id} CANCELLED`);
				});
			case pf(10):
				return act(s, async () => {
					const { po: sent, edi } = await sendPO(ctx.db, s.id);
					s.msg = `CUS0708I ${s.id} SENT TO ${sent.vendor_id} AS 850 ${edi.id}, ${money(sent.total)} AT COST`;
					return s;
				});
			case pf(11):
				return act(s, async () => {
					const { units } = await receivePO(ctx.db, ctx.user, s.id, "all");
					s.vals = undefined;
					s.msg = `CUS0714I ${s.id} RECEIVED IN FULL - ${units} UNITS PUT IN STOCK`;
					return s;
				});
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

function back(s: POState, msg?: string): Next {
	if (msg && s.back.p === "pos") s.back.msg = msg;
	return s.back;
}

async function act(s: POState, fn: () => Promise<Next>): Promise<Next> {
	try {
		return await fn();
	} catch (e) {
		explain(s, e);
		return s;
	}
}

function explain(s: POState, e: unknown): void {
	if (isCode(e, "invalid")) {
		s.errField = e.field === "rcv" ? undefined : e.field;
		s.msg = fieldMessage(e.field ?? "", e.message);
	} else if (isCode(e, "conflict")) {
		s.msg = `CUS0709E PURCHASE ORDER ${s.id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
	} else if (isCode(e, "not_found")) {
		s.msg = `CUS0705E ${e.message.toUpperCase()}`;
	} else {
		s.msg = fail(e);
	}
}

// apply makes the changes typed on an open PO: deletions, then the add line.
async function apply(ctx: Ctx, s: POState, f: Record<string, string>): Promise<Next> {
	const vals = { sku: (f.sku ?? "").trim().toUpperCase(), qty: (f.qty ?? "").trim() };
	s.vals = vals;
	let done = 0;
	try {
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			if (code !== "D") {
				s.errField = name;
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				return s;
			}
			await deletePOLine(ctx.db, s.id, Number(name.slice(4)));
			done++;
		}
		if (vals.sku) {
			if (!/^\d*$/.test(vals.qty)) {
				s.errField = "qty";
				s.msg = fieldMessage("qty", "quantity must be a whole number from 1 to 99999");
				return s;
			}
			const line = await addPOLine(ctx.db, s.id, vals.sku, vals.qty === "" ? 1 : Number(vals.qty));
			s.vals = undefined;
			s.msg = `CUS0713I LINE ${line.line} ADDED: ${line.quantity} ${line.sku} AT ${money(line.unit_cost)}`;
			return s;
		}
	} catch (e) {
		explain(s, e);
		return s;
	}
	s.vals = undefined;
	if (done > 0) s.msg = `CUS0716I PURCHASE ORDER ${s.id} UPDATED`;
	return s;
}

// receiveTyped receives the quantities typed in the RCV column.
async function receiveTyped(ctx: Ctx, s: POState, f: Record<string, string>): Promise<Next> {
	const qty = new Map<number, number>();
	s.vals = {};
	for (const [name, v] of Object.entries(f)) {
		if (!name.startsWith("rcv:") || v.trim() === "") continue;
		s.vals[name] = v.trim();
		if (!/^\d+$/.test(v.trim()) || Number(v) === 0) {
			s.errField = name;
			s.msg = fieldMessage("rcv", "quantity received must be a whole number above zero");
			return s;
		}
		qty.set(Number(name.slice(4)), Number(v));
	}
	if (qty.size === 0) {
		s.vals = undefined;
		return s;
	}
	try {
		const { po: after, units } = await receivePO(ctx.db, ctx.user, s.id, qty);
		s.vals = undefined;
		s.msg = after.status === "R"
			? `CUS0714I ${s.id} RECEIVED IN FULL - ${units} UNITS PUT IN STOCK`
			: `CUS0717I ${units} UNITS RECEIVED INTO STOCK - REST STILL DUE`;
	} catch (e) {
		explain(s, e);
	}
	return s;
}

// ---- CUSV03 VENDOR LIST ----

export const vendors: Program<VendorsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSV03");
		header(scr, ctx, "VENDOR LIST");
		let msg = s.msg ?? "";
		let list: Vendor[] = [];
		try {
			list = await listVendors(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		scr.text(5, 2, "SELECT: S=SHOW ITS PURCHASE ORDERS  H=HISTORY     EDI ID IS THE VENDOR NUMBER", { color: "blue" });
		const line = (id: string, name: string, where: string, lead: string, prods: string, open: string, st: string) =>
			`${pad(id, 6)} ${pad(name, 26)} ${pad(where, 18)} ${lpad(lead, 4)} ${lpad(prods, 8)} ${lpad(open, 8)}  ${st}`;
		scr.text(7, 2, "S " + line("VENDOR", "NAME", "LOCATION", "LEAD", "PRODUCTS", "OPEN POS", "ST"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((v, i) => {
			scr.input(9 + i, 2, 1, "sel:" + v.id, "", { bright: s.errSel === v.id });
			scr.text(9 + i, 4, line(v.id, v.name, `${v.city}, ${v.state}`, `${v.lead_days}D`, String(v.products ?? 0), String(v.open_pos ?? 0), v.status),
				{ color: v.status === "A" ? "green" : "pink" });
		});
		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (list.length > 0) scr.cursorTo("sel:" + list[top].id);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const id = name.slice(4);
					if (code === "H") return newVendHist(s, id);
					if (code !== "S") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = id;
						return s;
					}
					// Back to the PO list this came from, filtered to the vendor.
					const list = s.back.p === "pos" ? s.back : newPOs(s.back);
					return Object.assign(list, { vendor: id, top: 0, msg: undefined });
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, listRows(ctx), (await listVendors(ctx.db)).length);
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
