// Simulated EDI with customers' systems, in ANSI X12 (version 004010).
//
// An inbound interchange is filed as RECEIVED and put on the customer-jobs
// queue; the consumer processes it (processInterchange), files it as
// ACCEPTED or REJECTED and answers with a 997 functional acknowledgment.
//
//	850 purchase order  in   opens an invoice for the sender and adds its lines,
//	                         taking the stock; any bad line rejects the whole PO
//	997 acknowledgment  out  for every inbound interchange we can trace to a customer
//	856 ship notice     out  sent when an invoice that came from an 850 ships
//	810 invoice         out  sent when an invoice that came from an 850 is billed
//	820 remittance      in   marks each invoice it names paid, if the amounts agree
//
// Any customer can trade: its interchange ID (ISA06/ISA08) is its customer
// number, and ours is CUSTAPI. The EDISIM batch job (jobs.ts) plays the
// customers' side, sending purchase orders and paying the invoices we send.
//
// Vendors trade too, with their vendor number (V00001) as their ID. Their
// side is in purchasing.ts:
//
//	850 purchase order  out  our order for stock, sent from a purchase order
//	855 PO acknowledgment in the vendor accepts it and promises a ship date
//	856 ship notice     in   the vendor has shipped it

import { getCustomer } from "./data";
import { HttpError } from "./http";
import {
	addLine, billInvoice, cancelInvoice, createInvoice, getInvoice, payInvoice, type Invoice,
} from "./invoices";
import type { Transaction } from "./activity";
import type { StepResult } from "./jobs";
import { vendorDocument } from "./purchasing";

export const OUR_ID = "CUSTAPI";

export interface Interchange {
	id: string;
	direction: "I" | "O";
	type: string;
	partner: string;
	control: string;
	status: "RECEIVED" | "PROCESSING" | "ACCEPTED" | "REJECTED" | "SENT";
	reference: string;
	note: string;
	raw: string;
	created: string;
	created_by: string;
}

export const typeNames: Record<string, string> = {
	"850": "PURCHASE ORDER",
	"810": "INVOICE",
	"820": "REMITTANCE ADVICE",
	"855": "PO ACKNOWLEDGMENT",
	"856": "SHIP NOTICE",
	"997": "FUNCTIONAL ACKNOWLEDGMENT",
};

const functionalIDs: Record<string, string> = { "850": "PO", "810": "IN", "820": "RA", "855": "PR", "856": "SH", "997": "FA" };

const MAX_RAW = 64 * 1024;

// ---- X12 ----

const clean = (v: string | number) => String(v).replace(/[*~>\r\n]/g, " ").trim();
const two = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
const hm = (d: Date) => `${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;

// interchange wraps one transaction set in its ISA/GS/ST envelope.
export function interchange(from: string, to: string, control: number, type: string, body: (string | number)[][], at = new Date()): string {
	const ctl = String(control).padStart(9, "0");
	const segs: (string | number)[][] = [
		["ISA", "00", "".padEnd(10), "00", "".padEnd(10), "ZZ", from.padEnd(15), "ZZ", to.padEnd(15),
			ymd(at).slice(2), hm(at), "U", "00401", ctl, "0", "T", ">"],
		["GS", functionalIDs[type] ?? "XX", from, to, ymd(at), hm(at), control, "X", "004010"],
		["ST", type, "0001"],
		...body,
		["SE", body.length + 2, "0001"],
		["GE", 1, control],
		["IEA", 1, ctl],
	];
	return segs.map((s, i) => (i === 0 ? s.join("*") : s.map(clean).join("*")) + "~").join("\n");
}

export interface Parsed {
	sender: string;
	receiver: string;
	control: string;
	group: { id: string; control: string };
	type: string;
	setControl: string;
	body: string[][];
}

// header reads what it can of an interchange's envelope, for filing it.
export function header(raw: string): { sender: string; control: string; type: string } {
	const segs = segments(raw);
	const isa = segs.find((s) => s[0] === "ISA") ?? [];
	const st = segs.find((s) => s[0] === "ST") ?? [];
	return { sender: (isa[6] ?? "").trim(), control: (isa[13] ?? "").trim(), type: (st[1] ?? "").trim() };
}

function segments(raw: string): string[][] {
	const text = raw.trim();
	const el = text.length > 3 ? text[3] : "*";
	const term = text.length >= 106 && text.startsWith("ISA") ? text[105] : "~";
	return text.split(term).map((s) => s.trim()).filter(Boolean).map((s) => s.split(el));
}

// parse checks an interchange's envelope and returns its one transaction
// set. It throws an EdiError explaining what is wrong.
export function parse(raw: string): Parsed {
	if (!raw.trim().startsWith("ISA")) throw new EdiError("not an X12 interchange: no ISA segment");
	const segs = segments(raw);
	const isa = segs[0];
	if (isa.length < 17) throw new EdiError("ISA segment is short");
	const control = isa[13].trim();
	const iea = segs[segs.length - 1];
	if (iea[0] !== "IEA" || iea[2]?.trim() !== control) throw new EdiError(`IEA does not close interchange ${control}`);
	const gs = segs[1];
	if (gs?.[0] !== "GS") throw new EdiError("missing GS segment");
	const st = segs.findIndex((s) => s[0] === "ST");
	const se = segs.findIndex((s) => s[0] === "SE");
	if (st < 0 || se < st) throw new EdiError("missing ST/SE transaction set");
	if (Number(segs[se][1]) !== se - st + 1) throw new EdiError(`SE segment count ${segs[se][1]} should be ${se - st + 1}`);
	if (segs.filter((s) => s[0] === "ST").length > 1) throw new EdiError("only one transaction set per interchange is supported");
	return {
		sender: isa[6].trim(),
		receiver: isa[8].trim(),
		control,
		group: { id: gs[1] ?? "", control: gs[6] ?? "" },
		type: segs[st][1] ?? "",
		setControl: segs[st][2] ?? "",
		body: segs.slice(st + 1, se),
	};
}

export class EdiError extends Error {}

// Trading partners are customers (six digits) and vendors (V and five).
export const isVendorID = (id: string) => /^V\d{5}$/.test(id);
const isPartnerID = (id: string) => /^\d{6}$/.test(id) || isVendorID(id);

// ---- the mailbox ----

async function nextNumber(db: D1Database): Promise<number> {
	const row = await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'edi_id' RETURNING value")
		.first<{ value: number }>();
	return row!.value;
}

const ediID = (n: number) => "EDI" + String(n).padStart(5, "0");

async function file(db: D1Database, n: number, f: Omit<Interchange, "id" | "created">): Promise<Interchange> {
	const row = await db.prepare(
		`INSERT INTO edi (id, direction, type, partner, control, status, reference, note, raw, created, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
	).bind(ediID(n), f.direction, f.type, f.partner, f.control, f.status, f.reference, f.note, f.raw,
		new Date().toISOString(), f.created_by).first<Interchange>();
	return row!;
}

// send files an outbound interchange to a customer or vendor.
export async function send(db: D1Database, partner: string, type: string, body: (string | number)[][], reference: string): Promise<Interchange> {
	const n = await nextNumber(db);
	const raw = interchange(OUR_ID, partner, n, type, body);
	return file(db, n, {
		direction: "O", type, partner, control: String(n).padStart(9, "0"), status: "SENT", reference, note: "", raw, created_by: OUR_ID,
	});
}

// receive files an inbound interchange as RECEIVED. The caller queues it
// for processInterchange.
export async function receive(db: D1Database, user: string, raw: string): Promise<Interchange> {
	if (raw.length > MAX_RAW) throw new HttpError(413, "bad_request", "interchange too large");
	if (raw.trim() === "") throw new HttpError(422, "invalid", "interchange is empty");
	const h = header(raw);
	const partner = isPartnerID(h.sender) ? h.sender : "";
	return file(db, await nextNumber(db), {
		direction: "I", type: h.type.slice(0, 3), partner, control: h.control.slice(0, 9), status: "RECEIVED",
		reference: "", note: "", raw, created_by: user,
	});
}

export async function listInterchanges(db: D1Database, partner = ""): Promise<Interchange[]> {
	const { results } = await db.prepare(
		`SELECT id, direction, type, partner, control, status, reference, note, '' AS raw, created, created_by
		 FROM edi WHERE ?1 = '' OR partner = ?1 ORDER BY id DESC LIMIT 500`,
	).bind(partner).all<Interchange>();
	return results;
}

export async function getInterchange(db: D1Database, id: string): Promise<Interchange> {
	const row = await db.prepare("SELECT * FROM edi WHERE id = ?").bind(id.toUpperCase()).first<Interchange>();
	if (!row) throw new HttpError(404, "not_found", "interchange not found");
	return row;
}

// processInterchange handles a RECEIVED inbound interchange once: it claims
// it, applies it, files the outcome and sends the 997. A redelivered queue
// message finds it already claimed and does nothing.
export async function processInterchange(db: D1Database, id: string): Promise<Interchange | undefined> {
	const claimed = await db.prepare(
		"UPDATE edi SET status = 'PROCESSING' WHERE id = ? AND direction = 'I' AND status = 'RECEIVED' RETURNING *",
	).bind(id).first<Interchange>();
	if (!claimed) return undefined;

	let status: Interchange["status"] = "ACCEPTED";
	let reference = "";
	let note = "";
	let parsed: Parsed | undefined;
	try {
		parsed = parse(claimed.raw);
		if (parsed.receiver !== OUR_ID) throw new EdiError(`interchange is addressed to ${parsed.receiver}, not ${OUR_ID}`);
		if (!claimed.partner) throw new EdiError(`sender ${parsed.sender || "(blank)"} is not a trading partner`);
		if (isVendorID(claimed.partner)) reference = await vendorDocument(db, claimed.partner, parsed.type, parsed.body);
		else if (parsed.type === "850") reference = await purchaseOrder(db, claimed.partner, parsed.body);
		else if (parsed.type === "820") reference = await remittance(db, claimed.partner, parsed.body);
		else throw new EdiError(`transaction set ${parsed.type || "(blank)"} is not accepted`);
	} catch (e) {
		if (!(e instanceof EdiError || e instanceof HttpError)) {
			await db.prepare("UPDATE edi SET status = 'RECEIVED' WHERE id = ?").bind(id).run(); // let a retry have it
			throw e;
		}
		status = "REJECTED";
		note = e.message.toUpperCase().slice(0, 120);
		reference = e instanceof EdiError ? e.reference ?? "" : "";
	}
	const done = await db.prepare("UPDATE edi SET status = ?, reference = ?, note = ? WHERE id = ? RETURNING *")
		.bind(status, reference.slice(0, 40), note, id).first<Interchange>();
	if (claimed.partner) await acknowledge(db, claimed, parsed, status === "ACCEPTED");
	return done!;
}

// The reference is what was being worked on when an interchange was rejected.
export interface EdiError { reference?: string }

async function acknowledge(db: D1Database, inbound: Interchange, p: Parsed | undefined, ok: boolean): Promise<void> {
	const code = ok ? "A" : "R";
	await send(db, inbound.partner, "997", [
		["AK1", p?.group.id || functionalIDs[inbound.type] || "XX", p?.group.control || inbound.control],
		["AK2", p?.type || inbound.type || "000", p?.setControl || "0001"],
		ok ? ["AK5", "A"] : ["AK5", "R", "5"],
		["AK9", code, 1, 1, ok ? 1 : 0],
	], `${inbound.id} ${ok ? "ACCEPTED" : "REJECTED"}`);
}

const seg = (body: string[][], id: string) => body.filter((s) => s[0] === id);

// purchaseOrder opens an invoice for an 850 and adds its lines. If any line
// cannot be filled, the invoice is cancelled, returning the stock, and the
// whole order is rejected. It returns "PO <po> <invoice>".
async function purchaseOrder(db: D1Database, partner: string, body: string[][]): Promise<string> {
	const beg = seg(body, "BEG")[0];
	const po = (beg?.[3] ?? "").trim().toUpperCase();
	if (!po) throw new EdiError("BEG03 purchase order number is missing");
	const lines = seg(body, "PO1");
	if (lines.length === 0) throw new EdiError(`PO ${po} has no PO1 lines`);
	const dup = await db.prepare("SELECT id FROM invoices WHERE customer_id = ? AND po_number = ?").bind(partner, po).first<{ id: string }>();
	if (dup) throw Object.assign(new EdiError(`duplicate PO ${po}: already on ${dup.id}`), { reference: `PO ${po} ${dup.id}` });

	const inv = await createInvoice(db, "EDI", partner, po);
	try {
		for (const l of lines) {
			const n = l[1] || "?";
			const qty = Number(l[2]);
			const sku = productID(l);
			if (!sku) throw new EdiError(`PO1 line ${n}: no VP or BP product ID`);
			try {
				await addLine(db, inv.id, sku, Number.isInteger(qty) ? qty : NaN);
			} catch (e) {
				if (e instanceof HttpError) throw new EdiError(`PO1 line ${n}: ${e.message}`);
				throw e;
			}
		}
	} catch (e) {
		await cancelInvoice(db, inv.id);
		if (e instanceof EdiError) e.reference = `PO ${po}`;
		throw e;
	}
	return `PO ${po} ${inv.id}`;
}

// productID returns the SKU from a PO1 or IT1 segment's product ID pairs.
function productID(s: string[]): string {
	for (let i = 6; i + 1 < s.length; i += 2) {
		if (s[i] === "VP" || s[i] === "BP") return s[i + 1].trim().toUpperCase();
	}
	return "";
}

// remittance pays each invoice an 820 names in an RMR segment. All of them
// are checked before any is paid.
async function remittance(db: D1Database, partner: string, body: string[][]): Promise<string> {
	const rmrs = seg(body, "RMR").filter((s) => s[1] === "IV");
	if (rmrs.length === 0) throw new EdiError("820 has no RMR*IV invoice references");
	const paid: { id: string; amount: number }[] = [];
	for (const r of rmrs) {
		const id = (r[2] ?? "").trim().toUpperCase();
		const amount = Number(r[4]);
		const why = (msg: string) => Object.assign(new EdiError(msg), { reference: id });
		const inv = await db.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first<Invoice>();
		if (!inv || inv.customer_id !== partner) throw why(`invoice ${id || "(blank)"} is not one of yours`);
		if (inv.status === "P") throw why(`invoice ${id} is already paid`);
		if (inv.status !== "B") throw why(`invoice ${id} has not been billed`);
		if (amount !== inv.total) throw why(`invoice ${id} is for ${inv.total}, remittance says ${r[4] ?? "nothing"}`);
		paid.push({ id, amount });
	}
	const bpr = seg(body, "BPR")[0];
	const total = paid.reduce((t, p) => t + p.amount, 0);
	if (bpr && Number(bpr[2]) !== total) throw new EdiError(`BPR02 payment ${bpr[2]} does not equal the remittances, ${total}`);
	for (const p of paid) await payInvoice(db, "EDI", p.id);
	return paid.map((p) => p.id).join(" ");
}

// bill bills an invoice and, if it came from an 850, sends the customer an
// 810 for it.
export async function bill(db: D1Database, user: string, id: string): Promise<{ invoice: Invoice; transaction: Transaction; edi?: Interchange }> {
	const billed = await billInvoice(db, user, id);
	const edi = await sendInvoice(db, billed.invoice);
	return edi ? { ...billed, edi } : billed;
}

// fromEDIOrder reports whether an invoice was opened by a customer's 850.
export async function fromEDIOrder(db: D1Database, inv: Invoice): Promise<boolean> {
	const row = await db.prepare(
		"SELECT 1 FROM edi WHERE direction = 'I' AND type = '850' AND status = 'ACCEPTED' AND partner = ? AND reference = ?",
	).bind(inv.customer_id, `PO ${inv.po_number} ${inv.id}`).first();
	return row !== null;
}

async function sendInvoice(db: D1Database, inv: Invoice): Promise<Interchange | undefined> {
	if (!(await fromEDIOrder(db, inv))) return undefined;
	const { lines } = await getInvoice(db, inv.id);
	const cust = await getCustomer(db, inv.customer_id).catch(() => undefined);
	const billed = new Date(inv.billed);
	return send(db, inv.customer_id, "810", [
		["BIG", ymd(billed), inv.id, "", inv.po_number],
		["N1", "BT", cust?.name ?? "", "92", inv.customer_id],
		...lines.map((l) => ["IT1", l.line, l.quantity, "EA", l.unit_price, "", "VP", l.sku]),
		["TDS", inv.total * 100],
		["CTT", lines.length],
	], inv.id);
}

// ---- the trading partners' side, for the simulator ----

// partnerPO builds the 850 a customer's system would send.
export function partnerPO(partner: string, control: number, po: string, lines: { sku: string; qty: number; price: number }[]): string {
	const at = new Date();
	return interchange(partner, OUR_ID, control, "850", [
		["BEG", "00", "SA", po, "", ymd(at)],
		...lines.map((l, i) => ["PO1", i + 1, l.qty, "EA", l.price, "", "VP", l.sku]),
		["CTT", lines.length],
	], at);
}

// partnerRemittance builds the 820 a customer's system would send to pay
// invoices.
export function partnerRemittance(partner: string, control: number, invoices: { id: string; total: number }[]): string {
	const at = new Date();
	const total = invoices.reduce((t, i) => t + i.total, 0);
	return interchange(partner, OUR_ID, control, "820", [
		["BPR", "C", total, "C", "ACH", "CTX", "", "", "", "", "", "", "", "", "", ymd(at)],
		["TRN", "1", `RMT${control}`],
		...invoices.map((i) => ["RMR", "IV", i.id, "", i.total]),
	], at);
}

// partnersOrder is EDISIM's first step: up to three active customers send
// purchase orders for a few products in stock. About one order in five
// asks for a product we do not carry, and is rejected.
export async function partnersOrder(db: D1Database, job: { id: string }): Promise<StepResult> {
	const lines = ["", "PURCHASE ORDERS RECEIVED (850):"];
	const { results: custs } = await db.prepare(
		"SELECT id, name FROM customers WHERE status = 'A' ORDER BY random() LIMIT 3",
	).all<{ id: string; name: string }>();
	let rejected = 0;
	for (const [i, c] of custs.entries()) {
		const { results: prods } = await db.prepare(
			"SELECT sku, unit_price, on_hand FROM products WHERE status = 'A' AND on_hand > 0 ORDER BY random() LIMIT ?",
		).bind(1 + Math.floor(Math.random() * 3)).all<{ sku: string; unit_price: number; on_hand: number }>();
		if (prods.length === 0) {
			lines.push("  NO PRODUCTS IN STOCK - NO ORDERS SENT");
			return { rc: 4, lines };
		}
		const order = prods.map((p) => ({ sku: p.sku, price: p.unit_price, qty: 1 + Math.floor(Math.random() * Math.min(p.on_hand, 5)) }));
		if (Math.random() < 0.2) order.push({ sku: "XYZ-9999", price: 1, qty: 1 });
		const po = `${job.id.slice(3)}-${i + 1}`;
		const raw = partnerPO(c.id, Number(job.id.slice(3)) * 10 + i + 1, po, order);
		const filed = await receive(db, "EDISIM", raw);
		const done = (await processInterchange(db, filed.id))!;
		if (done.status === "REJECTED") rejected++;
		lines.push(`  ${filed.id} ${c.id} ${c.name.slice(0, 24).padEnd(24)} PO ${po.padEnd(9)} ${done.status.padEnd(9)} ${done.reference.split(" ")[2] ?? ""}`);
		if (done.note) lines.push(`           ${done.note}`);
	}
	if (custs.length === 0) lines.push("  NO ACTIVE CUSTOMERS");
	lines.push("", `${custs.length} ORDERS SENT, ${rejected} REJECTED`);
	return { rc: rejected > 0 ? 4 : 0, lines };
}

// partnersPay is EDISIM's second step: each customer pays the billed
// invoices we sent it an 810 for, with one 820.
export async function partnersPay(db: D1Database, job: { id: string }): Promise<StepResult> {
	const lines = ["", "REMITTANCES RECEIVED (820):"];
	const { results } = await db.prepare(
		`SELECT i.id, i.customer_id, i.total FROM invoices i
		 WHERE i.status = 'B' AND EXISTS (SELECT 1 FROM edi e WHERE e.direction = 'O' AND e.type = '810' AND e.reference = i.id)
		 ORDER BY i.customer_id, i.id`,
	).all<{ id: string; customer_id: string; total: number }>();
	const byCustomer = new Map<string, { id: string; total: number }[]>();
	for (const r of results) byCustomer.set(r.customer_id, [...(byCustomer.get(r.customer_id) ?? []), r]);
	let n = 0;
	for (const [cust, invs] of byCustomer) {
		const raw = partnerRemittance(cust, Number(job.id.slice(3)) * 10 + 5 + n++, invs);
		const filed = await receive(db, "EDISIM", raw);
		const done = (await processInterchange(db, filed.id))!;
		const total = invs.reduce((t, i) => t + i.total, 0);
		lines.push(`  ${filed.id} ${cust} PAID ${invs.map((i) => i.id).join(" ")}  $${total.toLocaleString("en-US")} ${done.status}`);
	}
	if (n === 0) lines.push("  NO BILLED EDI INVOICES TO PAY");
	return { rc: 0, lines };
}
