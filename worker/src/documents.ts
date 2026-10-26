// Printed documents: listings on green-bar paper, and the forms that go to
// customers (invoices, statements, dunning letters) as PDFs. The forms are
// laid out the way an impact printer fills preprinted stock: a 10-pitch,
// 6-lines-per-inch grid of Courier on a letter page, with the company's
// heading and the shaded boxes as the "preprint".
//
// Each document is built from plain data first, so the batch jobs can put
// the same thing on the spool as text and in the archive as a PDF.

import type { Transaction } from "./activity";
import type { Customer } from "./customer";
import { termsText, type Invoice, type InvoiceLine } from "./invoices";
import { Pdf, type RGB } from "./pdf";
import { AGING_BUCKETS, agedAccounts } from "./reports";
import type { PriceList } from "./sales";
import { printPages, type Output } from "./spool";

export const COMPANY = {
	name: "CUSTAPI DISTRIBUTING CO.",
	address: "1 DATA CENTER DRIVE",
	city: "POUGHKEEPSIE, NY 12601",
	phone: "(845) 555-0370",
};

const DAY = 86_400_000;

const GREEN: RGB = [0.83, 0.93, 0.83];
const SHADE: RGB = [0.9, 0.9, 0.9];
const RULE: RGB = [0.45, 0.45, 0.45];
const HOLE: RGB = [0.88, 0.88, 0.88];
const RED: RGB = [0.75, 0.1, 0.1];

const pad = (s: string | number, n: number, left = false) => {
	const v = String(s).slice(0, n);
	return left ? v.padStart(n) : v.padEnd(n);
};
const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US") + ".00";
const date = (iso: string) => iso.slice(0, 10);

// ---- listings ----

// A listing prints on 14 7/8 x 11 inch continuous forms, 132 columns at
// 10 characters to the inch and 66 lines at 6 to the inch, with tractor
// holes down both edges and a green bar every half inch.
const LISTING_W = 1071;
const LISTING_H = 792;
const CHAR = 7.2;
const LINE = 12;

// listingPdf prints an output group, paged as the printer would (see
// printPages): its heading on each page.
export function listingPdf(o: Pick<Output, "id" | "name" | "title">, lines: string[]): Uint8Array {
	const pdf = new Pdf(`${o.name} ${o.id} ${o.title}`.trim());
	const left = (LISTING_W - 132 * CHAR) / 2;
	for (const page of printPages(o, lines)) {
		pdf.page(LISTING_W, LISTING_H);
		for (let y = 18; y < LISTING_H; y += 36) {
			pdf.circle(18, y, 5.5, HOLE).circle(LISTING_W - 18, y, 5.5, HOLE);
		}
		// Bars on lines 4-6, 10-12 and so on: the first three are the margin.
		for (let row = 3; row < 63; row += 6) pdf.rect(left - 8, row * LINE, 132 * CHAR + 16, 3 * LINE, GREEN);
		page.forEach((text, i) => {
			if (text) pdf.text(left, (i + 4) * LINE - 3, text.slice(0, 132), { size: 12 });
		});
	}
	return pdf.bytes();
}

// ---- forms ----

// Form is a letter page as a grid of 75 columns by 60 lines inside half
// inch margins; col and row count from 0.
class Form {
	readonly pdf: Pdf;

	constructor(title: string) {
		this.pdf = new Pdf(title);
	}

	x(col: number): number {
		return 36 + col * CHAR;
	}

	y(row: number): number {
		return 36 + row * LINE;
	}

	// page starts a page with the company heading and the form's name.
	page(form: string): void {
		this.pdf.page();
		this.pdf.text(this.x(0), this.y(1), COMPANY.name, { font: "sans-bold", size: 16 });
		this.pdf.text(this.x(0), this.y(2) + 2, `${COMPANY.address}   ${COMPANY.city}   ${COMPANY.phone}`, { font: "sans", size: 8 });
		this.pdf.text(this.x(75) - form.length * 11.5, this.y(1), form, { font: "sans-bold", size: 20 });
		this.pdf.line(this.x(0), this.y(3), this.x(75), this.y(3), RULE, 1.5);
	}

	// put prints text at a grid position.
	put(col: number, row: number, text: string, bold = false): void {
		if (text) this.pdf.text(this.x(col), this.y(row + 1) - 3, text, { font: bold ? "mono-bold" : "mono", size: 12 });
	}

	// caption prints a small label above a box or column.
	caption(col: number, row: number, text: string): void {
		this.pdf.text(this.x(col), this.y(row + 1) - 4, text, { font: "sans-bold", size: 7, color: RULE });
	}

	shade(col: number, row: number, cols: number, rows: number, fill = SHADE): void {
		this.pdf.rect(this.x(col), this.y(row), cols * CHAR, rows * LINE, fill);
	}

	frame(col: number, row: number, cols: number, rows: number): void {
		this.pdf.box(this.x(col), this.y(row), cols * CHAR, rows * LINE, RULE);
	}

	// stamp prints a large red notice with its baseline at the bottom of row.
	stamp(col: number, row: number, text: string): void {
		this.pdf.text(this.x(col), this.y(row + 1), text, { font: "sans-bold", size: 20, color: RED });
	}

	footer(lines: string[]): void {
		this.pdf.line(this.x(0), this.y(56), this.x(75), this.y(56), RULE);
		lines.forEach((l, i) => this.pdf.text(this.x(0), this.y(57 + i) + 2, l, { font: "sans", size: 8 }));
	}

	// addressBlock prints a name and address in a captioned frame.
	addressBlock(col: number, row: number, caption: string, lines: string[]): void {
		this.caption(col, row, caption);
		this.frame(col, row + 1, 36, 5);
		lines.slice(0, 4).forEach((l, i) => this.put(col + 1, row + 1 + i + 0.5, l.slice(0, 34)));
	}

	// facts prints labeled values in a frame at the right.
	facts(row: number, pairs: [string, string][]): void {
		this.frame(44, row, 31, pairs.length + 1);
		pairs.forEach(([k, v], i) => {
			this.caption(45, row + i + 0.5, k);
			this.put(58, row + i + 0.5, pad(v, 16, true));
		});
	}

	// table prints a shaded heading row, then the rows, starting a new
	// page (with the heading again) when they reach the footer.
	table(heading: string, rows: string[], form: string, top: number): number {
		let row = top;
		const head = () => {
			this.shade(0, row, 75, 1);
			this.put(0, row, heading, true);
			row++;
		};
		head();
		rows.forEach((text, i) => {
			if (row >= 53) {
				this.put(0, row, pad("CONTINUED ON NEXT PAGE", 75, true));
				this.page(form);
				row = 5;
				head();
			}
			if (i % 2 === 1) this.shade(0, row, 75, 1, [0.96, 0.96, 0.96]);
			this.put(0, row, text);
			row++;
		});
		return row;
	}

	bytes(): Uint8Array {
		return this.pdf.bytes();
	}
}

function customerLines(c: Pick<Customer, "name" | "address" | "city" | "state" | "zip">): string[] {
	return [c.name, c.address, `${c.city}, ${c.state} ${c.zip}`].filter((l) => l.trim() !== ",");
}

// ---- invoices ----

const INVOICE_HEAD = "LN  SKU        DESCRIPTION                     QTY  UNIT PRICE      AMOUNT";

function invoiceRow(l: InvoiceLine): string {
	return `${pad(l.line, 3, true)} ${pad(l.sku, 10)} ${pad(l.description, 28)} ${pad(l.quantity, 6, true)} ${pad(money(l.unit_price), 11, true)} ${pad(money(l.quantity * l.unit_price), 12, true)}`;
}

// invoicePdf prints an invoice. One that is still open prints as a pro
// forma; a paid one is stamped PAID.
export function invoicePdf(inv: Invoice, lines: InvoiceLine[], cust: Customer): Uint8Array {
	const f = new Form(`INVOICE ${inv.id}`);
	const form = inv.status === "O" ? "PRO FORMA" : "INVOICE";
	f.page(form);
	f.addressBlock(0, 4, "BILL TO", customerLines(cust));
	f.facts(5, [
		["INVOICE NO", inv.id],
		["INVOICE DATE", date(inv.billed || inv.created)],
		["ACCOUNT", inv.customer_id],
		["PO NUMBER", inv.po_number || "NONE"],
		["TERMS", termsText(inv)],
	]);
	if (inv.status === "P") f.stamp(0, 12, `PAID ${date(inv.paid)}`);
	if (inv.status === "O") f.put(0, 12, "NOT YET BILLED - FOR INFORMATION ONLY", true);
	// A line priced below list by the customer's pricing (sales.ts) shows
	// its list price and the agreement under it.
	const rows = lines.flatMap((l) => l.list_price > l.unit_price
		? [invoiceRow(l), `${"".padEnd(15)}LIST ${money(l.list_price)} EACH - ${l.price_rule || "DISCOUNT"}`]
		: [invoiceRow(l)]);
	let end = f.table(INVOICE_HEAD, rows, form, 14);
	const list = lines.reduce((t, l) => t + l.quantity * Math.max(l.list_price, l.unit_price), 0);
	if (list > inv.subtotal) {
		f.put(0, ++end, pad("TOTAL AT LIST", 62, true) + " " + pad(money(list), 12, true));
		f.put(0, ++end, pad("LESS YOUR DISCOUNTS", 62, true) + " " + pad(money(inv.subtotal - list), 12, true));
	}
	if (inv.tax_note) {
		f.put(0, ++end, pad("SUBTOTAL", 62, true) + " " + pad(money(inv.subtotal), 12, true));
		f.put(0, ++end, pad(`SALES TAX ${inv.tax_note}`, 62, true) + " " + pad(money(inv.tax), 12, true));
	}
	f.put(0, end + 1, pad("INVOICE TOTAL", 62, true) + " " + pad(money(inv.total), 12, true), true);
	if (inv.billed) {
		const due = new Date(Date.parse(inv.billed) + 30 * DAY).toISOString();
		f.put(0, end + 2, pad("PAYMENT DUE BY", 62, true) + " " + pad(date(due), 12, true));
		const disc = Math.round((inv.subtotal * inv.early_pct10) / 1000);
		if (disc > 0 && inv.status === "B") {
			const by = new Date(Date.parse(inv.billed) + inv.early_days * DAY).toISOString();
			f.put(0, end + 3, pad(`OR PAY ${money(inv.total - disc)} BY ${date(by)}, LESS ${termsText(inv).split(" NET")[0]}`, 62, true) + " " +
				pad(money(-disc), 12, true));
		}
		if (inv.discount_taken > 0) f.put(0, end + 3, pad("EARLY PAYMENT DISCOUNT TAKEN", 62, true) + " " + pad(money(-inv.discount_taken), 12, true));
	}
	f.footer([
		`PLEASE REMIT TO ${COMPANY.name}, ${COMPANY.address}, ${COMPANY.city}. QUOTE INVOICE ${inv.id} WITH YOUR PAYMENT.`,
		"TERMS NET 30 DAYS. ACCOUNTS MORE THAN 60 DAYS PAST DUE ARE PLACED ON CREDIT HOLD.",
	]);
	return f.bytes();
}

// ---- statements ----

export interface Statement {
	customer: Customer;
	asOf: string; // RFC 3339, UTC
	opening: number; // the balance before the activity shown
	activity: Transaction[]; // oldest first
	aging: number[]; // current, 31-60, 61-90, over 90
}

// buildStatements returns a statement for each open account with a
// balance, or for the one customer asked for, with the last 30 days of
// activity.
export async function buildStatements(db: D1Database, only = "", now = Date.now()): Promise<Statement[]> {
	const since = new Date(now - 30 * DAY).toISOString();
	const [custs, txns] = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT * FROM customers WHERE (?1 = '' AND status <> 'C' AND balance <> 0) OR id = ?1 ORDER BY id").bind(only),
		db.prepare("SELECT * FROM transactions WHERE posted >= ? AND (?2 = '' OR customer_id = ?2) ORDER BY seq").bind(since, only),
	]);
	const aged = new Map((await agedAccounts(db, now)).map((a) => [a.id, a.buckets]));
	const asOf = new Date(now).toISOString();
	return (custs.results as unknown as Customer[]).map((customer) => {
		const activity = (txns.results as unknown as Transaction[]).filter((t) => t.customer_id === customer.id);
		const first = activity[0];
		const opening = first ? first.balance - (first.type === "I" ? first.amount : -first.amount) : customer.balance;
		return { customer, asOf, opening, activity, aging: aged.get(customer.id) ?? [0, 0, 0, 0] };
	});
}

function statementRow(t: Transaction): string {
	const charge = t.type === "I" ? money(t.amount) : "";
	const paid = t.type === "I" ? "" : money(t.amount);
	return `${date(t.posted)}  ${pad(t.type === "I" ? "INVOICE" : "PAYMENT", 8)} ${pad(t.reference, 14)} ${pad(charge, 12, true)} ${pad(paid, 12, true)} ${pad(money(t.balance), 13, true)}`;
}

const STATEMENT_HEAD = "DATE        TYPE     REFERENCE           CHARGES     PAYMENTS       BALANCE";

// statementLines is a statement as the CUSSTMT job prints it.
export function statementLines(s: Statement): string[] {
	const c = s.customer;
	const lines = [
		"",
		`STATEMENT  ${c.id}  ${c.name}  AS OF ${date(s.asOf)}`,
		`           ${c.address}`,
		`           ${c.city}, ${c.state} ${c.zip}`,
		"",
		`  ${STATEMENT_HEAD}`,
		`  ${pad("", 10)}  ${pad("BALANCE FORWARD", 50)}${pad(money(s.opening), 13, true)}`.trimEnd(),
	];
	for (const t of s.activity) lines.push(`  ${statementRow(t)}`);
	if (s.activity.length === 0) lines.push("  NO ACTIVITY IN THE LAST 30 DAYS");
	lines.push(`  ${pad("BALANCE DUE", 62)}${pad(money(c.balance), 13, true)}`);
	return lines;
}

export function statementPdf(s: Statement): Uint8Array {
	const c = s.customer;
	const f = new Form(`STATEMENT ${c.id} ${date(s.asOf)}`);
	f.page("STATEMENT");
	f.addressBlock(0, 4, "ACCOUNT OF", customerLines(c));
	f.facts(5, [
		["ACCOUNT", c.id],
		["STATEMENT DATE", date(s.asOf)],
		["CREDIT LIMIT", money(c.credit_limit)],
		["AMOUNT DUE", money(c.balance)],
	]);
	if (c.status === "H") f.put(0, 12, "ACCOUNT ON CREDIT HOLD - PLEASE CALL US", true);
	const rows = [`${pad("", 10)}  ${pad("BALANCE FORWARD", 50)}${pad(money(s.opening), 13, true)}`, ...s.activity.map(statementRow)];
	let row = f.table(STATEMENT_HEAD, rows, "STATEMENT", 14);
	row++;
	f.shade(0, row, 75, 1);
	f.put(0, row, AGING_BUCKETS.map((b) => pad(b, 14, true)).join("") + pad("TOTAL DUE", 19, true), true);
	f.put(0, row + 1, s.aging.map((b) => pad(money(b), 14, true)).join("") + pad(money(c.balance), 19, true));
	f.footer([
		`PLEASE REMIT TO ${COMPANY.name}, ${COMPANY.address}, ${COMPANY.city}. QUOTE ACCOUNT ${c.id} WITH YOUR PAYMENT.`,
		`QUESTIONS ABOUT YOUR ACCOUNT? CALL ACCOUNTS RECEIVABLE AT ${COMPANY.phone}.`,
	]);
	return f.bytes();
}

// ---- price lists ----

const PRICE_HEAD = `${pad("SKU", 10)} ${pad("DESCRIPTION", 24)} ${pad("LIST", 9, true)} ${pad("YOUR PRICE", 12, true)}  BASIS`;

// priceListPdf prints a customer's price list (sales.ts priceList): each
// product at list and at its price, and the quantity prices under it.
export function priceListPdf(pl: PriceList, cust: Customer): Uint8Array {
	const f = new Form(`PRICE LIST ${cust.id} ${pl.day}`);
	f.page("PRICE LIST");
	f.addressBlock(0, 4, "PRICES FOR", customerLines(cust));
	f.facts(5, [
		["ACCOUNT", cust.id],
		["PRICES AS OF", pl.day],
		["PRODUCTS", String(pl.items.length)],
		["BELOW LIST", String(pl.items.filter((i) => i.price < i.list).length)],
	]);
	const rows = pl.items.flatMap((i) => [
		`${pad(i.sku, 10)} ${pad(i.description, 24)} ${pad(money(i.list), 9, true)} ${pad(money(i.price), 12, true)}  ${pad(i.until ? `${i.rule} TO ${i.until.slice(5)}` : i.rule, 15)}`,
		...(i.breaks.length ? [`${pad("", 11)}BY QUANTITY: ${i.breaks.map((b) => `${b.qty}+ ${money(b.price)}`).join("  ")}`.slice(0, 75)] : []),
	]);
	f.table(PRICE_HEAD, rows, "PRICE LIST", 12);
	f.footer([
		"PRICES ARE EACH, IN U.S. DOLLARS, BEFORE SALES TAX AND FREIGHT, AND MAY CHANGE WITHOUT NOTICE.",
		`QUESTIONS ABOUT YOUR PRICING? CALL YOUR SALES REPRESENTATIVE OR ${COMPANY.phone}.`,
	]);
	return f.bytes();
}

// ---- dunning letters ----

export interface LetterInvoice {
	id: string;
	po_number: string;
	billed: string;
	days: number; // past due
	total: number;
}

export interface Letter {
	level: number; // 1 reminder, 2 second notice, 3 final notice
	customer: Pick<Customer, "id" | "name" | "address" | "city" | "state" | "zip">;
	sent: string; // RFC 3339, UTC
	invoices: LetterInvoice[];
}

export const dunningLevels: Record<number, string> = { 1: "REMINDER", 2: "SECOND NOTICE", 3: "FINAL NOTICE" };

const letterText: Record<number, string[]> = {
	1: ["OUR RECORDS SHOW THE INVOICES BELOW ARE PAST DUE. IF YOUR PAYMENT HAS", "CROSSED THIS LETTER, PLEASE ACCEPT OUR THANKS."],
	2: ["WE HAVE WRITTEN BEFORE ABOUT THE INVOICES BELOW, WHICH ARE NOW MORE", "THAN 30 DAYS PAST DUE. PLEASE REMIT PAYMENT AT ONCE."],
	3: ["THE INVOICES BELOW ARE MORE THAN 60 DAYS PAST DUE. YOUR ACCOUNT HAS", "BEEN PLACED ON HOLD UNTIL THEY ARE PAID IN FULL."],
};

const LETTER_HEAD = "INVOICE   PO NUMBER              BILLED      DAYS PAST DUE      AMOUNT";
const amt = (n: number) => (n ? "$" + n.toLocaleString("en-US") : "");

function letterRow(d: LetterInvoice): string {
	return `${pad(d.id, 9)} ${pad(d.po_number, 22)} ${date(d.billed)}  ${pad(d.days, 13, true)} ${pad(amt(d.total), 11, true)}`;
}

function letterTotal(l: Letter): number {
	return l.invoices.reduce((t, d) => t + d.total, 0);
}

// letterLines is a dunning letter as the CUSDUNN job prints it.
export function letterLines(l: Letter): string[] {
	const c = l.customer;
	const name = dunningLevels[l.level];
	return [
		"",
		`${"-".repeat(20)} ${name} ${"-".repeat(56 - name.length)}`,
		"",
		`  ${c.name}`,
		`  ${c.address}`,
		`  ${c.city}, ${c.state} ${c.zip}                       ACCOUNT ${c.id}`,
		"",
		...letterText[l.level].map((t) => `  ${t}`),
		"",
		`  ${LETTER_HEAD}`,
		...l.invoices.map((d) => `  ${letterRow(d)}`),
		`  ${pad("TOTAL PAST DUE", 59)} ${pad(amt(letterTotal(l)), 11, true)}`,
	];
}

export function letterPdf(l: Letter): Uint8Array {
	const c = l.customer;
	const name = dunningLevels[l.level];
	const f = new Form(`${name} ${c.id} ${date(l.sent)}`);
	f.page(name);
	f.addressBlock(0, 4, "TO", customerLines(c));
	f.facts(5, [["ACCOUNT", c.id], ["DATE", date(l.sent)], ["AMOUNT PAST DUE", money(letterTotal(l))]]);
	if (l.level === 3) f.stamp(44, 10, "ACCOUNT ON HOLD");
	f.put(0, 12, "DEAR CUSTOMER:");
	letterText[l.level].forEach((t, i) => f.put(0, 14 + i, t));
	const end = f.table(LETTER_HEAD, l.invoices.map(letterRow), name, 18);
	f.put(0, end, pad("TOTAL PAST DUE", 59, true) + " " + pad(amt(letterTotal(l)), 11, true), true);
	f.put(0, end + 3, "SINCERELY,");
	f.put(0, end + 5, "ACCOUNTS RECEIVABLE");
	f.put(0, end + 6, COMPANY.name);
	f.footer([
		`PLEASE REMIT TO ${COMPANY.name}, ${COMPANY.address}, ${COMPANY.city}. QUOTE ACCOUNT ${c.id} WITH YOUR PAYMENT.`,
		`IF YOU HAVE ALREADY PAID, OR HAVE A QUESTION ABOUT THESE INVOICES, CALL US AT ${COMPANY.phone}.`,
	]);
	return f.bytes();
}
