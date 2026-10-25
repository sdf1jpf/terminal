import { getCustomer } from "../data";
import type { Customer } from "../customer";
import {
	addLine, cancelInvoice, changeLine, createInvoice, deleteLine, getInvoice, listInvoices, payInvoice, setPO,
	statusNames, type Invoice, type InvoiceLine,
} from "../invoices";
import { bill } from "../edi";
import { searchProducts } from "../products";
import { padID } from "./detail";
import { newSkuSearch, searchText } from "./skusearch";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, value, type Color, type Ctx, type Screen } from "./screen";
import { fail, isCode, pf, type InvoiceState, type InvoicesState, type Next, type Program, type State } from "./program";

// CUSI01 INVOICE LIST lists invoices, newest first, for one customer or
// all, with the customer's account position, opens new ones and marks
// billed ones paid. CUSI02 INVOICE builds an open invoice from the
// product file, bills it to the customer's account and marks it paid.
// PF4 on an open invoice, or a ? or * in the SKU, searches the product
// file (CUSI03, skusearch.ts) for the SKU to add.
// Open invoices show in white, billed ones in yellow and paid ones in green.

const statusColor = (status: string): Color => (status === "O" ? "white" : status === "B" ? "yellow" : "green");

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(id: string, cust: string, po: string, status: string, total: string, created: string): string {
	return `${pad(id, 8)} ${pad(cust, 7)} ${pad(po, 22)} ${pad(status, 6)} ${lpad(total, 12)}  ${created}`;
}

async function customer(ctx: Ctx, id: string): Promise<Customer | undefined> {
	try {
		return await getCustomer(ctx.db, id);
	} catch (e) {
		if (isCode(e, "not_found")) return undefined;
		throw e;
	}
}

export function newInvoices(back: State, cust = ""): InvoicesState {
	return { p: "invoices", back, cust: cust.trim() ? padID(cust) : "" };
}

export const invoices: Program<InvoicesState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSI01");
		header(scr, ctx, "INVOICE LIST");
		let msg = s.msg ?? "";
		let list: Invoice[] = [];
		try {
			list = await listInvoices(ctx.db, s.cust ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "CUSTOMER NUMBER ===>");
		scr.input(4, 23, 6, "cust", s.cust ?? "", { numeric: true, bright: s.errField === "cust" });
		const c = s.cust ? await customer(ctx, s.cust) : undefined;
		if (c) {
			scr.text(4, 31, pad(c.name, 30), { color: "white", bright: true });
			const status = ({ A: "ACTIVE", H: "ON HOLD", C: "CLOSED" } as Record<string, string>)[c.status] ?? "";
			scr.text(4, right(scr, 70), lpad(status, 9), { color: custColor(c.status) });
			account(scr, 5, c, list);
		}
		if (list.length > 0) {
			scr.text(6, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, "SELECT: S=SHOW  P=MARK PAID", { color: "blue" });
		scr.text(7, 2, "S " + listLine("INVOICE", "CUST NO", "PO NUMBER", "STATUS", "TOTAL", "CREATED"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((inv, i) => {
			scr.input(9 + i, 2, 1, "sel:" + inv.id, "", { bright: s.errSel === inv.id });
			scr.text(9 + i, 4, listLine(inv.id, inv.customer_id, inv.po_number, statusNames[inv.status], money(inv.total),
				stamp(ctx, inv.created).slice(0, 10)), { color: statusColor(inv.status) });
		});
		if (list.length === 0) scr.text(9, 4, s.cust ? "NO INVOICES FOR THIS CUSTOMER" : "NO INVOICES ON FILE", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=NEW INVOICE  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.errSel && shown.some((inv) => inv.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		else scr.cursorTo("cust");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const typed = (input.fields.cust ?? "").trim();
		const cust = typed ? padID(typed) : "";
		if (input.aid === "ENTER" && input.modified.has("cust") && cust !== (s.cust ?? "")) {
			s.cust = cust;
			s.top = 0;
			if (cust && !(await customer(ctx, cust))) {
				s.msg = `CUS0201E CUSTOMER ${cust} NOT FOUND`;
				s.errField = "cust";
			}
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const id = name.slice(4);
					if (code === "S") return { p: "invoice", back: s, id };
					s.errSel = id;
					if (code !== "P") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						return s;
					}
					try {
						const { invoice: inv, transaction: t } = await payInvoice(ctx.db, ctx.user, id);
						s.errSel = undefined;
						s.msg = `CUS0508I INVOICE ${id} PAID, ${money(inv.total)} PAYMENT POSTED - BALANCE NOW ${money(t.balance)}`;
					} catch (e) {
						s.msg = isCode(e, "invalid") ? fieldMessage("", e.message) : fail(e);
					}
					return s;
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5): {
				const id = s.cust || cust;
				if (!id) {
					s.msg = "CUS0501E ENTER A CUSTOMER NUMBER FOR THE NEW INVOICE";
					s.errField = "cust";
					return s;
				}
				try {
					const inv = await createInvoice(ctx.db, ctx.user, id);
					s.cust = id;
					return { p: "invoice", back: s, id: inv.id, msg: `CUS0502I INVOICE ${inv.id} OPENED FOR ${id}` };
				} catch (e) {
					if (isCode(e, "not_found")) s.msg = `CUS0201E CUSTOMER ${id} NOT FOUND`;
					else if (isCode(e, "invalid")) s.msg = `CUS0503E ${e.message.toUpperCase()}`;
					else s.msg = fail(e);
					s.errField = "cust";
					return s;
				}
			}
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await listInvoices(ctx.db, s.cust ?? "")).length;
				scroll(s, input.aid, rows, total);
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

const custColor = (status: string): Color => (status === "H" ? "yellow" : status === "C" ? "pink" : "green");

// account shows a customer's position: what it owes, its credit, and how
// much of what it owes is on unpaid invoices.
function account(scr: Screen, row: number, c: Customer, list: Invoice[]): void {
	const avail = c.credit_limit - c.balance;
	const unpaid = list.filter((i) => i.status === "B").reduce((t, i) => t + i.total, 0);
	const items: [string, string, Color][] = [
		["BALANCE", money(c.balance), "white"],
		["LIMIT", money(c.credit_limit), "green"],
		["AVAILABLE", money(avail), avail < Math.trunc(c.credit_limit / 10) ? "red" : "green"],
		["UNPAID", money(unpaid), unpaid > 0 ? "yellow" : "green"],
	];
	let col = 4;
	for (const [name, amount, color] of items) {
		label(scr, row, col, name);
		scr.text(row, col + name.length + 1, amount, { color });
		col += name.length + amount.length + 4;
	}
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

// ---- CUSI02 INVOICE ----

const lineRows = (ctx: Ctx) => ctx.rows - 14;

function lineText(ln: string, sku: string, desc: string): string {
	return `${lpad(ln, 3)} ${pad(sku, 10)} ${pad(desc, 30)}`;
}

// Each field's error has its own message number.
const messageIDs: Record<string, string> = { sku: "CUS0510E", qty: "CUS0511E", po: "CUS0512E" };
const fieldMessage = (field: string, msg: string) => `${messageIDs[field] ?? "CUS0519E"} ${msg.toUpperCase()}`;

export const invoice: Program<InvoiceState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSI02");
		header(scr, ctx, "INVOICE");
		let inv: Invoice | undefined;
		let lines: InvoiceLine[] = [];
		let msg = s.msg ?? "";
		try {
			({ invoice: inv, lines } = await getInvoice(ctx.db, s.id));
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS0504E INVOICE ${s.id} NOT FOUND` : fail(e);
		}
		const open = inv?.status === "O";

		label(scr, 4, 4, dots("INVOICE", 12));
		scr.text(4, 18, s.id, { color: "white", bright: true });
		if (inv) {
			scr.text(4, 28, statusNames[inv.status], { color: statusColor(inv.status), bright: true });
			const col = right(scr, 58);
			label(scr, 4, col, "TOTAL");
			scr.text(4, col + 6, lpad(money(inv.total), 15), { color: "white", bright: true });

			const c = await customer(ctx, inv.customer_id);
			label(scr, 5, 4, dots("CUSTOMER", 12));
			value(scr, 5, 18, `${inv.customer_id} ${c?.name ?? "(NOT ON FILE)"}`);
			if (c) {
				label(scr, 5, col, "BALANCE");
				scr.text(5, col + 8, lpad(money(c.balance), 13), { color: "white" });
			}
			label(scr, 6, 4, dots("PO NUMBER", 12));
			if (open) scr.input(6, 18, 22, "po", inv.po_number, { bright: s.errField === "po" });
			else value(scr, 6, 18, inv.po_number);
			const when = [`OPENED ${stamp(ctx, inv.created).slice(0, 10)}`];
			if (inv.billed) when.push(`BILLED ${stamp(ctx, inv.billed).slice(0, 10)}`);
			if (inv.paid) when.push(`PAID ${stamp(ctx, inv.paid).slice(0, 10)}`);
			scr.text(6, right(scr, 44), lpad(when.join("  "), 36), { color: "green" });

			if (open) {
				label(scr, 8, 4, "ADD LINE:  SKU ===>");
				scr.input(8, 24, 10, "sku", s.vals?.sku ?? "", { bright: s.errField === "sku" });
				label(scr, 8, 37, "QTY ===>");
				scr.input(8, 46, 5, "qty", s.vals?.qty ?? "", { numeric: true, bright: s.errField === "qty" });
				scr.text(9, 2, "SELECT: D=DELETE LINE    OVERTYPE A QUANTITY TO CHANGE IT", { color: "blue" });
			}

			const rows = lineRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(10, 2, "S " + lineText("LN", "SKU", "DESCRIPTION") + "      QTY     PRICE      AMOUNT",
				{ color: "white", bright: true });
			scr.text(11, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			lines.slice(top, top + rows).forEach((l, i) => {
				const row = 12 + i;
				const color = statusColor(inv!.status);
				if (open) scr.input(row, 2, 1, `sel:${l.line}`, "");
				scr.text(row, 4, lineText(String(l.line), l.sku, l.description), { color });
				if (open) scr.input(row, 51, 5, `qty:${l.line}`, String(l.quantity), { numeric: true, bright: s.errField === `qty:${l.line}` });
				else scr.text(row, 51, lpad(String(l.quantity), 5), { color });
				scr.text(row, 58, lpad(money(l.unit_price), 9), { color });
				scr.text(row, 68, lpad(money(l.quantity * l.unit_price), 11), { color });
			});
			if (lines.length === 0) scr.text(12, 4, "NO LINES YET - ADD A PRODUCT ABOVE", { color: "yellow" });
			if (lines.length > rows) {
				scr.text(10, right(scr, 66), `${top + 1}-${Math.min(top + rows, lines.length)}/${lines.length}`, { color: "white" });
			}
		}

		message(scr, msg);
		keys(scr, open
			? "ENTER=APPLY PF1=HELP PF3=EXIT PF4=FIND SKU PF7/8=SCROLL PF9=CANCEL PF10=BILL"
			: inv?.status === "B"
				? "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF11=MARK PAID  PF12=CANCEL"
				: "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errField && open) scr.cursorTo(s.errField);
		else if (s.focus && open) scr.cursorTo(s.focus);
		else if (open) scr.cursorTo("sku");
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errField = s.confirm = s.focus = undefined;
		// The keys that act on the invoice depend on its status: lines are
		// changed only while it is open, and only a billed one can be paid.
		const active: Record<string, string> = { ENTER: "O", PF4: "O", PF9: "O", PF10: "O", PF11: "B" };
		if (active[input.aid]) {
			const status = await getInvoice(ctx.db, s.id).then(({ invoice }) => invoice.status, () => "");
			if (status !== active[input.aid]) {
				s.msg = input.aid === "ENTER" ? undefined : invalidKey(input.aid);
				return s;
			}
		}
		switch (input.aid) {
			case "ENTER":
				return apply(ctx, s, input.fields, input.modified);
			case pf(3):
			case pf(12):
				return back(s);
			case pf(4):
				s.vals = { sku: (input.fields.sku ?? "").trim().toUpperCase(), qty: (input.fields.qty ?? "").trim() };
				return newSkuSearch(s, s.vals.sku);
			case pf(7):
			case pf(8): {
				const { lines } = await getInvoice(ctx.db, s.id).catch(() => ({ lines: [] }));
				scroll(s, input.aid, lineRows(ctx), lines.length);
				return s;
			}
			case pf(9):
				if (!confirm) {
					s.confirm = true;
					s.msg = `CUS0505W PRESS PF9 AGAIN TO CANCEL INVOICE ${s.id} AND RETURN ITS STOCK`;
					return s;
				}
				return act(s, async () => {
					await cancelInvoice(ctx.db, s.id);
					return back(s, `CUS0506I INVOICE ${s.id} CANCELLED, STOCK RETURNED`);
				});
			case pf(10):
				return act(s, async () => {
					const { invoice: inv, edi } = await bill(ctx.db, ctx.user, s.id);
					s.msg = `CUS0507I INVOICE ${s.id} BILLED, ${money(inv.total)} POSTED TO ${inv.customer_id}${edi ? ` - 810 ${edi.id} SENT` : ""}`;
					return s;
				});
			case pf(11):
				return act(s, async () => {
					const { invoice: inv } = await payInvoice(ctx.db, ctx.user, s.id);
					s.msg = `CUS0508I INVOICE ${s.id} PAID, ${money(inv.total)} PAYMENT POSTED TO ${inv.customer_id}`;
					return s;
				});
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

function back(s: InvoiceState, msg?: string): Next {
	if (msg && s.back.p === "invoices") s.back.msg = msg;
	return s.back;
}

// act runs an invoice action, turning its errors into messages.
async function act(s: InvoiceState, fn: () => Promise<Next>): Promise<Next> {
	try {
		return await fn();
	} catch (e) {
		explain(s, e);
		return s;
	}
}

function explain(s: InvoiceState, e: unknown, field?: string): void {
	if (isCode(e, "invalid")) {
		s.errField = field && e.field === "qty" ? field : e.field;
		s.msg = fieldMessage(e.field ?? "", e.message);
	} else if (isCode(e, "conflict")) {
		s.msg = `CUS0509E INVOICE ${s.id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
	} else if (isCode(e, "not_found")) {
		s.msg = `CUS0504E ${e.message.toUpperCase()}`;
	} else {
		s.msg = fail(e);
	}
}

// apply makes the changes typed on the invoice: deletions first, then
// quantity changes, the PO number and finally the add line. It stops at
// the first error, keeping the changes made before it.
async function apply(ctx: Ctx, s: InvoiceState, f: Record<string, string>, modified: Set<string>): Promise<Next> {
	const vals = { sku: (f.sku ?? "").trim().toUpperCase(), qty: (f.qty ?? "").trim() };
	s.vals = vals;
	let done = 0;
	const deleted = new Set<string>();
	try {
		for (const [name, v] of Object.entries(f)) {
			const code = v.trim().toUpperCase();
			if (!name.startsWith("sel:") || code === "") continue;
			const line = name.slice(4);
			if (code !== "D") {
				s.errField = name;
				s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
				return s;
			}
			await deleteLine(ctx.db, s.id, Number(line));
			deleted.add(line);
			done++;
		}
		for (const name of modified) {
			if (!name.startsWith("qty:") || deleted.has(name.slice(4))) continue;
			const qty = (f[name] ?? "").trim();
			if (!/^\d+$/.test(qty)) {
				s.errField = name;
				s.msg = fieldMessage("qty", "quantity must be a whole number from 1 to 99999 - use D to delete a line");
				return s;
			}
			try {
				await changeLine(ctx.db, s.id, Number(name.slice(4)), Number(qty));
			} catch (e) {
				explain(s, e, name);
				return s;
			}
			done++;
		}
		if (modified.has("po")) {
			await setPO(ctx.db, s.id, f.po ?? "");
			done++;
		}
		if (/[?*]/.test(vals.sku)) return newSkuSearch(s, vals.sku);
		if (vals.sku) {
			const qty = vals.qty === "" ? 1 : Number(vals.qty);
			if (!/^\d*$/.test(vals.qty)) {
				s.errField = "qty";
				s.msg = fieldMessage("qty", "quantity must be a whole number from 1 to 99999");
				return s;
			}
			const line = await addLine(ctx.db, s.id, vals.sku, qty).catch(async (e) => {
				// A SKU that is not on file may be part of one or of a
				// description: offer the products it matches.
				if (!isCode(e, "invalid") || !/not on file/.test(e.message)) throw e;
				const found = await searchProducts(ctx.db, vals.sku);
				if (found.length === 0) throw e;
				return found.length;
			});
			if (typeof line === "number") {
				return newSkuSearch(s, vals.sku, `CUS0515I ${vals.sku} IS NOT A SKU - ${line} PRODUCT${line === 1 ? "" : "S"} MATCH`);
			}
			s.vals = undefined;
			s.msg = `CUS0513I LINE ${line.line} ADDED: ${line.quantity} ${line.sku} AT ${money(line.unit_price)}`;
			return s;
		}
	} catch (e) {
		explain(s, e);
		return s;
	}
	s.vals = undefined;
	if (done > 0) s.msg = `CUS0514I INVOICE ${s.id} UPDATED`;
	return s;
}
