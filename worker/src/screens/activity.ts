import type { Change, Transaction } from "../activity";
import { customerEvents, type CustomerEvent } from "../events";
import { getCustomer } from "../data";
import type { Customer } from "../customer";
import { loadDetail, padID } from "./detail";
import { newInvoices } from "./invoices";
import { getInvoice, statusNames, type Invoice, type InvoiceLine } from "../invoices";
import { typeNames, type Interchange } from "../edi";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, value, type Color, type Ctx, type Screen } from "./screen";
import { fail, isCode, pf, type ActivityState, type EventState, type Next, type Program } from "./program";

// CUSM03 EVENT HISTORY is the customer's audit trail: record changes,
// invoices opened, billed and paid, newest first and numbered; typing a
// line number shows that event on CUSM05 EVENT DETAIL. It is read only:
// postings come from the invoice screens (invoices.ts). It works for deleted
// customers too, since their events outlive the record.

// open reads a customer, returning it or an error message.
async function open(ctx: Ctx, id: string): Promise<Customer | string> {
	try {
		return await getCustomer(ctx.db, id);
	} catch (e) {
		return isCode(e, "not_found") ? `CUS0201E CUSTOMER ${id} NOT FOUND` : fail(e);
	}
}

// current reads the customer a panel shows, or undefined if there is none.
async function current(ctx: Ctx, id?: string): Promise<Customer | undefined> {
	if (!id) return undefined;
	const c = await open(ctx, id);
	return typeof c === "string" ? undefined : c;
}

const statusColor = (s: string): Color => (s === "H" ? "yellow" : s === "C" ? "pink" : "green");

// account draws the customer number field and, once loaded, who it is.
function account(scr: Screen, id: string, cust: Customer | undefined, errID: boolean): void {
	label(scr, 4, 4, "CUSTOMER NUMBER ===>");
	scr.input(4, 25, 6, "id", id, { numeric: true, bright: errID });
	if (cust) {
		scr.text(4, 33, cust.name, { color: "white", bright: true });
		const status = ({ A: "ACTIVE", H: "ON HOLD", C: "CLOSED" } as Record<string, string>)[cust.status] ?? "";
		scr.text(4, right(scr, 70), lpad(status, 9), { color: statusColor(cust.status) });
	}
}

// changedID returns the customer number typed over the current one, or "".
function changedID(input: { fields: Record<string, string>; modified: Set<string> }, id?: string): string {
	if (!input.modified.has("id")) return "";
	const typed = (input.fields.id ?? "").trim();
	return typed === "" || padID(typed) === id ? "" : typed;
}

function page<T>(s: { top?: number; msg?: string }, aid: string, rows: number, list: T[]): void {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		s.top = Math.max((s.top ?? 0) - rows, 0);
	} else if ((s.top ?? 0) + rows >= list.length) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
	} else {
		s.top = Math.min((s.top ?? 0) + rows, list.length - rows);
	}
}

// ---- CUSM03 EVENT HISTORY ----

export async function newActivity(ctx: Ctx, back: ActivityState["back"], id: string): Promise<ActivityState> {
	const a: ActivityState = { p: "activity", back };
	if (id) await loadActivity(ctx, a, id);
	return a;
}

async function loadActivity(ctx: Ctx, a: ActivityState, id: string): Promise<void> {
	a.id = padID(id);
	a.top = 0;
	const c = await open(ctx, a.id);
	if (typeof c !== "string") return;
	// A deleted customer's events outlive it.
	if ((await events(ctx, a.id)).length === 0) {
		a.msg = c;
		a.errField = "id";
	} else {
		a.msg = `CUS0251I CUSTOMER ${a.id} HAS BEEN DELETED - HISTORY ONLY`;
	}
}

// activityRows is how many events fit on a page: 11 on 24x80.
const activityRows = (ctx: Ctx) => ctx.rows - 13;

function eventLine(n: string, date: string, time: string, event: string, text: string, amount: string, user: string): string {
	return `${lpad(n, 3)} ${pad(date, 10)} ${pad(time, 5)} ${pad(event, 8)} ${pad(text, 26)} ${lpad(amount, 11)} ${pad(user, 8)}`;
}

const eventColors: Record<string, Color> = {
	ADDED: "turquoise", CHANGED: "green", DELETED: "pink", OPENED: "white", BILLED: "yellow", INVOICE: "yellow", PAYMENT: "turquoise",
	"EDI IN": "blue", "EDI OUT": "blue",
};

async function events(ctx: Ctx, id?: string): Promise<CustomerEvent[]> {
	return id ? customerEvents(ctx.db, id) : [];
}

export const activity: Program<ActivityState> = {
	async render(ctx, a) {
		const scr = newScreen(ctx, "CUSM03");
		header(scr, ctx, "EVENT HISTORY");
		let msg = a.msg ?? "";
		const cust = await current(ctx, a.id);
		account(scr, a.id ?? "", cust, a.errField === "id");

		let list: CustomerEvent[] = [];
		if (a.id) {
			try {
				list = await events(ctx, a.id);
			} catch (e) {
				msg = fail(e);
			}
		}
		if (cust) {
			const avail = cust.credit_limit - cust.balance;
			const items: [string, string, Color][] = [
				["BALANCE", money(cust.balance), "white"],
				["LIMIT", money(cust.credit_limit), "green"],
				["AVAILABLE", money(avail), avail < Math.trunc(cust.credit_limit / 10) ? "red" : "green"],
			];
			let col = 4;
			for (const [name, amount, color] of items) {
				label(scr, 5, col, name);
				scr.text(5, col + name.length + 1, amount, { color });
				col += name.length + amount.length + 5;
			}
		}
		if (list.length > 0 || cust) {
			label(scr, 7, 2, "SHOW LINE ===>");
			scr.input(7, 17, 3, "line", "", { numeric: true, bright: a.errField === "line" });
			scr.text(7, 22, "TYPE A LINE NUMBER AND PRESS ENTER FOR ITS DETAILS", { color: "blue" });
		}
		const rows = activityRows(ctx);
		const top = Math.min(a.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(8, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(9, 2, eventLine("NO.", "DATE", "TIME", "EVENT", "DETAIL", "AMOUNT", "USER"), { color: "white", bright: true });
		scr.text(10, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((e, i) => {
			const [date, time] = stamp(ctx, e.at).split(" ");
			const amount = e.amount === undefined ? "" : money(e.amount);
			scr.text(11 + i, 2, eventLine(String(top + i + 1), date ?? "", time ?? "", e.event, e.text, amount, e.by),
				{ color: eventColors[e.event] ?? "green" });
		});
		if (a.id && list.length === 0 && !a.errField) scr.text(11, 4, "NO EVENTS ON FILE", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=INVOICES  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo(a.errField || (cust ? "line" : "id"));
		return scr;
	},

	async handle(ctx, a, input) {
		a.msg = "";
		a.errField = undefined;
		switch (input.aid) {
			case "ENTER": {
				const loaded = await current(ctx, a.id);
				let id = changedID(input, a.id);
				if (id !== "" || (!loaded && !(input.fields.line ?? "").trim())) {
					if (id === "") id = input.fields.id ?? "";
					if (id.trim() === "") {
						a.msg = "CUS0202E ENTER A CUSTOMER NUMBER";
						a.errField = "id";
						return a;
					}
					await loadActivity(ctx, a, id);
					return a;
				}
				return showLine(ctx, a, (input.fields.line ?? "").trim());
			}
			case pf(3):
			case pf(12):
				if (a.back.p === "detail" && a.back.loaded && a.back.cust) {
					await loadDetail(ctx, a.back, a.back.cust.id); // show the latest balance
				}
				return a.back;
			case pf(5):
				if (!(await current(ctx, a.id))) {
					a.msg = "CUS0204E DISPLAY A CUSTOMER FIRST";
					a.errField = "id";
					return a;
				}
				return newInvoices(a, a.id!);
			case pf(7):
			case pf(8):
				page(a, input.aid, activityRows(ctx), await events(ctx, a.id));
				return a;
		}
		a.msg = invalidKey(input.aid);
		return a;
	},
};

const isInvoice = (ref: string) => /^INV\d{5}$/.test(ref);

// showLine opens the details of the event on a line. With no line number,
// Enter just reads the events again.
async function showLine(ctx: Ctx, a: ActivityState, line: string): Promise<Next> {
	if (line === "") return a;
	const list = await events(ctx, a.id);
	const n = Number(line);
	if (!/^\d+$/.test(line) || n < 1 || n > list.length) {
		a.errField = "line";
		a.msg = list.length === 0 ? "CUS0246E THERE ARE NO EVENTS TO SHOW" : `CUS0246E LINE MUST BE 1 TO ${list.length}`;
		return a;
	}
	const e = list[n - 1];
	return { p: "event", back: a, id: a.id!, kind: e.kind, key: e.key, line: n };
}

// ---- CUSM05 EVENT DETAIL ----

// The invoice an event concerns, if any.
async function eventInvoice(ctx: Ctx, s: EventState): Promise<string> {
	if (s.kind === "V") return s.key;
	if (s.kind === "E") {
		const x = await ctx.db.prepare("SELECT reference FROM edi WHERE id = ? AND partner = ?").bind(s.key, s.id).first<{ reference: string }>();
		return x?.reference.match(/INV\d{5}/)?.[0] ?? "";
	}
	if (s.kind !== "T") return "";
	const t = await ctx.db.prepare("SELECT reference FROM transactions WHERE seq = ? AND customer_id = ?")
		.bind(Number(s.key), s.id).first<{ reference: string }>();
	return t && isInvoice(t.reference) ? t.reference : "";
}

export const event: Program<EventState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSM05");
		header(scr, ctx, "EVENT DETAIL");
		let msg = s.msg ?? "";
		const cust = await current(ctx, s.id);
		label(scr, 4, 4, dots("CUSTOMER", 16));
		value(scr, 4, 22, `${s.id} ${cust?.name ?? ""}`);
		scr.text(4, right(scr, 66), `LINE ${s.line}`, { color: "white" });

		const fields: [string, string][] = [];
		let where = 15; // where the invoice goes
		if (s.kind === "T") {
			const t = await ctx.db.prepare("SELECT * FROM transactions WHERE seq = ? AND customer_id = ?")
				.bind(Number(s.key), s.id).first<Transaction>();
			if (t) {
				const pay = t.type === "P";
				fields.push(
					["EVENT", pay ? "PAYMENT POSTED" : "INVOICE BILLED"],
					["AMOUNT", money(pay ? -t.amount : t.amount)],
					["REFERENCE", t.reference || "(NONE)"],
					["BALANCE BEFORE", money(pay ? t.balance + t.amount : t.balance - t.amount)],
					["BALANCE AFTER", money(t.balance)],
					["POSTED", stamp(ctx, t.posted)],
					["POSTED BY", t.posted_by],
				);
			}
		} else if (s.kind === "A") {
			const c = await ctx.db.prepare("SELECT * FROM audit WHERE seq = ? AND customer_id = ?")
				.bind(Number(s.key), s.id).first<Change>();
			if (c) {
				fields.push(["EVENT", `RECORD ${({ ADD: "ADDED", CHANGE: "CHANGED", DELETE: "DELETED" } as Record<string, string>)[c.action] ?? c.action}`]);
				if (c.action === "CHANGE") {
					fields.push(["FIELD", c.field], ["OLD VALUE", c.old_value || "(BLANK)"], ["NEW VALUE", c.new_value || "(BLANK)"]);
				}
				fields.push(["CHANGED", stamp(ctx, c.at)], ["CHANGED BY", c.by]);
			}
		} else if (s.kind === "E") {
			const x = await ctx.db.prepare("SELECT * FROM edi WHERE id = ? AND partner = ?").bind(s.key, s.id).first<Interchange>();
			if (x) {
				fields.push(
					["EVENT", `EDI ${x.type} ${typeNames[x.type] ?? ""} ${x.direction === "I" ? "RECEIVED" : "SENT"}`],
					["INTERCHANGE", `${x.id}  CONTROL ${x.control}`],
					["STATUS", x.status],
					["REFERENCE", x.reference || "(NONE)"],
					["AT", stamp(ctx, x.created)],
				);
				if (x.note) fields.push(["REJECTED", x.note.slice(0, scr.cols - 24)]);
			}
		} else {
			const inv = await ctx.db.prepare("SELECT * FROM invoices WHERE id = ? AND customer_id = ?")
				.bind(s.key, s.id).first<Invoice>();
			if (inv) fields.push(["EVENT", "INVOICE OPENED"], ["OPENED", stamp(ctx, inv.created)], ["OPENED BY", inv.created_by]);
			where = 10;
		}
		if (fields.length === 0) msg = "CUS0247E THE EVENT IS NO LONGER ON FILE";
		fields.forEach(([name, v], i) => {
			label(scr, 6 + i, 4, dots(name, 16));
			value(scr, 6 + i, 22, v);
		});

		const id = fields.length > 0 ? await eventInvoice(ctx, s) : "";
		const inv = id ? await getInvoice(ctx.db, id).catch(() => undefined) : undefined;
		if (inv) {
			const { invoice: i, lines } = inv;
			const when = [`OPENED ${stamp(ctx, i.created).slice(0, 10)}`];
			if (i.billed) when.push(`BILLED ${stamp(ctx, i.billed).slice(0, 10)}`);
			if (i.paid) when.push(`PAID ${stamp(ctx, i.paid).slice(0, 10)}`);
			scr.text(where, 4, `INVOICE ${i.id}  ${statusNames[i.status]}  PO ${i.po_number || "(NONE)"}  TOTAL ${money(i.total)}`,
				{ color: "white", bright: true });
			scr.text(where + 1, 4, when.join("  "), { color: "green" });
			const room = Math.max(scr.rows - where - 5, 0);
			lines.slice(0, room).forEach((l, n) => {
				scr.text(where + 3 + n, 4, `${lpad(String(l.line), 3)} ${pad(l.sku, 10)} ${pad(l.description, 30)} ${lpad(String(l.quantity), 5)} ${lpad(money(l.unit_price), 9)} ${lpad(money(l.quantity * l.unit_price), 11)}`,
					{ color: "green" });
			});
			if (lines.length > room && room > 0) {
				scr.text(where + 2 + room, 4, `... ${lines.length - room + 1} MORE LINES - PF4 SHOWS THEM ALL`, { color: "yellow" });
			}
		} else if (id) {
			scr.text(where, 4, `INVOICE ${id} IS NO LONGER ON FILE`, { color: "yellow" });
		}
		message(scr, msg);
		keys(scr, `PF1=HELP  PF3=EXIT  ${inv ? "PF4=SHOW INVOICE  " : ""}${s.kind === "E" ? "PF6=SHOW X12  " : ""}PF12=CANCEL`);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4): {
				const id = await eventInvoice(ctx, s);
				if (id && (await getInvoice(ctx.db, id).catch(() => undefined))) return { p: "invoice", back: s, id };
				break;
			}
			case pf(6):
				if (s.kind === "E") return { p: "edidoc", back: s, id: s.key };
				break;
			case "ENTER":
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
