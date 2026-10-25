import { customerHistory, listTransactions, parsePosting, postTransaction, type Change, type Transaction } from "../activity";
import { getCustomer } from "../data";
import type { Customer } from "../customer";
import { loadDetail, padID } from "./detail";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, type Color, type Ctx, type Opts, type Screen } from "./screen";
import { fail, isCode, pf, type ActivityState, type HistoryState, type Next, type Program } from "./program";

// CUSM03 ACCOUNT ACTIVITY posts invoices and payments to a customer and
// lists the account's transactions, newest first. CUSM04 CHANGE HISTORY
// lists who changed a customer record, when, and what changed; it works for
// deleted customers too, since the history outlives the record.

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

// ---- CUSM03 ACCOUNT ACTIVITY ----

export async function newActivity(ctx: Ctx, back: ActivityState["back"], id: string): Promise<ActivityState> {
	const a: ActivityState = { p: "activity", back };
	if (id) await loadActivity(ctx, a, id);
	return a;
}

async function loadActivity(ctx: Ctx, a: ActivityState, id: string): Promise<void> {
	a.id = padID(id);
	a.top = 0;
	a.vals = undefined;
	const c = await open(ctx, a.id);
	if (typeof c === "string") {
		a.msg = c;
		a.errField = "id";
	}
}

// activityRows is how many transactions fit on a page: 10 on 24x80.
const activityRows = (ctx: Ctx) => ctx.rows - 14;

function activityLine(date: string, time: string, type: string, ref: string, amount: string, balance: string, user: string): string {
	return `${pad(date, 10)} ${pad(time, 5)} ${pad(type, 7)} ${pad(ref, 12)} ${lpad(amount, 12)} ${lpad(balance, 13)}  ${pad(user, 8)}`;
}

async function transactions(ctx: Ctx, id: string): Promise<Transaction[]> {
	return (await listTransactions(ctx.db, id)) ?? [];
}

export const activity: Program<ActivityState> = {
	async render(ctx, a) {
		const scr = newScreen(ctx, "CUSM03");
		header(scr, ctx, "ACCOUNT ACTIVITY");
		let msg = a.msg ?? "";
		const cust = await current(ctx, a.id);
		account(scr, a.id ?? "", cust, a.errField === "id");

		if (cust) {
			const posting: [string, string, number, Opts][] = [
				["type", "TYPE", 1, {}],
				["amount", "AMOUNT", 9, { numeric: true }],
				["ref", "REFERENCE", 12, {}],
			];
			posting.forEach(([name, text, length, opts], i) => {
				label(scr, 6 + i, 4, dots(text, 19));
				scr.input(6 + i, 25, length, name, a.vals?.[name] ?? "", { ...opts, bright: a.errField === name });
			});
			scr.text(6, 28, "I=INVOICE  P=PAYMENT", { color: "blue" });

			const col = right(scr, 58);
			const avail = cust.credit_limit - cust.balance;
			label(scr, 6, col, "BALANCE");
			scr.text(6, col + 10, lpad(money(cust.balance), 11), { color: "white" });
			label(scr, 7, col, "LIMIT");
			scr.text(7, col + 10, lpad(money(cust.credit_limit), 11), { color: "green" });
			label(scr, 8, col, "AVAILABLE");
			scr.text(8, col + 10, lpad(money(avail), 11), { color: avail < Math.trunc(cust.credit_limit / 10) ? "red" : "green" });

			let list: Transaction[] = [];
			try {
				list = await transactions(ctx, cust.id);
			} catch (e) {
				msg = fail(e);
			}
			const rows = activityRows(ctx);
			const top = Math.min(a.top ?? 0, Math.max(list.length - rows, 0));
			if (list.length > 0) {
				scr.text(10, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
			}
			scr.text(11, 4, activityLine("DATE", "TIME", "TYPE", "REFERENCE", "AMOUNT", "BALANCE", "USER"), { color: "white", bright: true });
			scr.text(12, 4, "-".repeat(scr.cols - 6), { color: "blue" });
			list.slice(top, top + rows).forEach((t, i) => {
				const pay = t.type === "P";
				const [date, time] = stamp(ctx, t.posted).split(" ");
				scr.text(13 + i, 4, activityLine(date ?? "", time ?? "", pay ? "PAYMENT" : "INVOICE", t.reference,
					money(pay ? -t.amount : t.amount), money(t.balance), t.posted_by), { color: pay ? "turquoise" : "green" });
			});
			if (list.length === 0) scr.text(13, 4, "NO ACTIVITY ON FILE", { color: "yellow" });
		}

		message(scr, msg);
		keys(scr, "ENTER=POST  PF1=HELP  PF3=EXIT  PF6=HISTORY  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo(a.errField || (cust ? "type" : "id"));
		return scr;
	},

	async handle(ctx, a, input) {
		a.msg = "";
		a.errField = undefined;
		switch (input.aid) {
			case "ENTER": {
				const loaded = await current(ctx, a.id);
				let id = changedID(input, a.id);
				if (id !== "" || !loaded) {
					if (id === "") id = input.fields.id ?? "";
					if (id.trim() === "") {
						a.msg = "CUS0202E ENTER A CUSTOMER NUMBER";
						a.errField = "id";
						return a;
					}
					await loadActivity(ctx, a, id);
					return a;
				}
				return post(ctx, a, input.fields);
			}
			case pf(3):
			case pf(12):
				if (a.back.p === "detail" && a.back.loaded && a.back.cust) {
					await loadDetail(ctx, a.back, a.back.cust.id); // show the new balance
				}
				return a.back;
			case pf(6):
				if (!(await current(ctx, a.id))) {
					a.msg = "CUS0204E DISPLAY A CUSTOMER FIRST";
					a.errField = "id";
					return a;
				}
				return newHistory(ctx, a, a.id!);
			case pf(7):
			case pf(8):
				page(a, input.aid, activityRows(ctx), a.id ? await transactions(ctx, a.id) : []);
				return a;
			case "CLEAR":
				a.vals = undefined;
				return a;
		}
		a.msg = invalidKey(input.aid);
		return a;
	},
};

const postingMessageIDs: Record<string, string> = { type: "CUS0240E", amount: "CUS0241E", ref: "CUS0242E" };

function postingMessage(field: string, msg: string): string {
	return `${postingMessageIDs[field] ?? "CUS0249E"} ${msg.toUpperCase()}`;
}

// post sends the posting fields. With nothing filled in, Enter just reads
// the account again.
async function post(ctx: Ctx, a: ActivityState, f: Record<string, string>): Promise<Next> {
	const vals = { type: f.type ?? "", amount: f.amount ?? "", ref: f.ref ?? "" };
	a.vals = vals;
	const type = vals.type.trim().toUpperCase();
	const amount = vals.amount.trim();
	const ref = vals.ref.trim();
	if (type === "" && amount === "" && ref === "") {
		a.vals = undefined;
		return a;
	}
	if (!/^-?\d+$/.test(amount)) {
		a.errField = "amount";
		a.msg = postingMessage("amount", "amount must be a whole number of dollars above zero");
		return a;
	}
	try {
		const t = await postTransaction(ctx.db, ctx.user, a.id!, parsePosting({ type, amount: Number(amount), reference: ref }));
		a.vals = undefined;
		a.top = 0;
		const kind = t.type === "P" ? "PAYMENT" : "INVOICE";
		a.msg = `CUS0245I ${kind} OF ${money(t.amount)} POSTED - BALANCE NOW ${money(t.balance)}`;
	} catch (e) {
		if (isCode(e, "invalid")) {
			a.errField = e.field;
			a.msg = postingMessage(e.field ?? "", e.message);
		} else if (isCode(e, "not_found")) {
			a.vals = undefined;
			a.errField = "id";
			a.msg = `CUS0214E CUSTOMER ${a.id} NO LONGER EXISTS`;
		} else {
			a.msg = fail(e);
		}
	}
	return a;
}

// ---- CUSM04 CHANGE HISTORY ----

export async function newHistory(ctx: Ctx, back: HistoryState["back"], id: string): Promise<HistoryState> {
	const h: HistoryState = { p: "history", back };
	if (id) await loadHistory(ctx, h, id);
	return h;
}

async function loadHistory(ctx: Ctx, h: HistoryState, id: string): Promise<void> {
	h.id = padID(id);
	h.top = 0;
	const c = await open(ctx, h.id);
	let list: Change[];
	try {
		list = await customerHistory(ctx.db, h.id);
	} catch (e) {
		h.msg = fail(e);
		return;
	}
	if (list.length > 0 && typeof c === "string") {
		h.msg = `CUS0251I CUSTOMER ${h.id} HAS BEEN DELETED - HISTORY ONLY`;
	} else if (typeof c === "string") {
		h.msg = c;
		h.errField = "id";
	}
}

// historyRows is how many changes fit on a page: 14 on 24x80.
const historyRows = (ctx: Ctx) => ctx.rows - 10;

function historyLine(date: string, time: string, user: string, action: string, field: string): string {
	return `${pad(date, 10)} ${pad(time, 5)} ${pad(user, 8)} ${pad(action, 6)} ${pad(field, 7)} `;
}

const blank = (s: string) => (s === "" ? "(BLANK)" : s);

export const history: Program<HistoryState> = {
	async render(ctx, h) {
		const scr = newScreen(ctx, "CUSM04");
		header(scr, ctx, "CHANGE HISTORY");
		let msg = h.msg ?? "";
		account(scr, h.id ?? "", await current(ctx, h.id), h.errField === "id");

		let list: Change[] = [];
		if (h.id) {
			try {
				list = await customerHistory(ctx.db, h.id);
			} catch (e) {
				msg = fail(e);
			}
		}
		const rows = historyRows(ctx);
		const top = Math.min(h.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(5, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 4, historyLine("DATE", "TIME", "USER", "ACTION", "FIELD") + "OLD VALUE > NEW VALUE", { color: "white", bright: true });
		scr.text(7, 4, "-".repeat(scr.cols - 6), { color: "blue" });
		const width = scr.cols - 4 - historyLine("", "", "", "", "").length - 2;
		list.slice(top, top + rows).forEach((c, i) => {
			let what = `${blank(c.old_value ?? "")} > ${blank(c.new_value ?? "")}`;
			let color: Color = "green";
			if (c.action === "ADD") [what, color] = ["RECORD ADDED", "turquoise"];
			if (c.action === "DELETE") [what, color] = ["RECORD DELETED", "pink"];
			const [date, time] = stamp(ctx, c.at).split(" ");
			scr.text(8 + i, 4, historyLine(date ?? "", time ?? "", c.by, c.action, c.field ?? "") + what.slice(0, width), { color });
		});
		if (list.length === 0 && h.id && !h.errField) scr.text(8, 4, "NO CHANGES ON FILE", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=ACTIVITY  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo("id");
		return scr;
	},

	async handle(ctx, h, input) {
		h.msg = "";
		h.errField = undefined;
		switch (input.aid) {
			case "ENTER": {
				const id = (input.fields.id ?? "").trim();
				if (id === "") {
					Object.assign(h, { msg: "CUS0202E ENTER A CUSTOMER NUMBER", errField: "id", id: undefined });
					return h;
				}
				await loadHistory(ctx, h, id);
				return h;
			}
			case pf(3):
			case pf(12):
				return h.back;
			case pf(5):
				if (!(await current(ctx, h.id))) {
					h.msg = "CUS0204E DISPLAY A CUSTOMER FIRST";
					h.errField = "id";
					return h;
				}
				if (h.back.p === "activity" && h.back.id === h.id) {
					await loadActivity(ctx, h.back, h.id!);
					return h.back;
				}
				return newActivity(ctx, h, h.id!);
			case pf(7):
			case pf(8):
				page(h, input.aid, historyRows(ctx), h.id ? await customerHistory(ctx.db, h.id) : []);
				return h;
		}
		h.msg = invalidKey(input.aid);
		return h;
	},
};
