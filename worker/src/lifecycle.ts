// Order lifecycles. Each invoice's life from order to cash runs as one
// OrderLifecycle workflow, named after the invoice:
//
//	opened (on a screen, by REST, or by a customer's 850)
//	  -> waits for an operator to correct any 850 lines held as EDI exceptions
//	  -> released to the warehouse -> picked and packed -> shipped (856 for EDI orders)
//	  -> tracked with the carrier: out for delivery, delivered (tracking.ts)
//	  -> billed when it ships (810 for EDI orders)
//	  -> waits for payment (by hand, or a customer's 820)
//	  -> a reminder when payment is due (net 30), a second notice 30 days
//	     later, a final notice 30 days after that, which puts the account on hold
//	  -> paid: the lifecycle is complete. A cancelled invoice ends it too.
//
// D1 is the record. The screens and REST endpoints change invoices and
// shipments as they always have, and read their status from D1. The
// workflow reads the same rows: each turn it looks at the order, records on
// its timeline what has happened since the last look, does what the order
// is waiting on the system for (billing, dunning), and then waits for the
// next change, or until its next deadline. Every step can run twice: it
// either checks D1 first or writes with a unique key.
//
// Changes reach the workflow through the order_signals outbox, which D1
// triggers fill on every change however it was made (migration 0027). The
// cron trigger delivers them every minute (deliverSignals): the first
// signal for an order starts its workflow, the rest wake it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { putArchive } from "./archive";
import type { Customer } from "./customer";
import { dunningLevels, letterLines, letterPdf, type Letter } from "./documents";
import { bill } from "./edi";
import { HttpError } from "./http";
import type { Env } from "./index";
import type { Invoice } from "./invoices";
import { holdAccount } from "./ledger";
import { mailable, mailDocument } from "./mail";
import type { Shipment } from "./shipping";
import { syslog } from "./syslog";
import { alertPO, lookAtPO } from "./polifecycle";

// The name the lifecycle acts under, on postings, letters and the log.
export const LIFECYCLE = "CUSORDER";

// The event type that wakes a waiting lifecycle.
export const SIGNAL = "changed";

const DAY = 86_400_000;
const IDLE = 30 * DAY; // look again after this long even if nothing changed
const RETRY_BILL = 3_600_000; // after billing failed, try again in an hour
const MAX_TURNS = 300; // well inside a workflow's step limit

export type OrderKind = "I" | "P";

export interface OrderParams {
	kind: OrderKind;
	id: string;
}

export interface Flow {
	kind: OrderKind;
	ref: string;
	status: "S" | "W" | "C"; // started, waiting, complete
	next: string;
	next_at: string;
	started: string;
	updated: string;
	ended: string;
	outcome: string;
}

export interface TimelineEvent {
	seq: number;
	kind: OrderKind;
	ref: string;
	event: string;
	key: string;
	at: string;
	detail: string;
	amount: number | null;
	by: string;
}

export const flowStatusNames: Record<Flow["status"], string> = { S: "STARTED", W: "WAITING", C: "COMPLETE" };

// What one look at an order decided.
export interface Look {
	done?: string; // the lifecycle is over: PAID or CANCELLED
	bill?: boolean; // shipped and not billed: bill it
	dun?: number; // a dunning level is due: send it
	alert?: string; // a purchase order is late: tell the operator (polifecycle.ts)
	wait?: number; // otherwise wait this long, in ms, for a change
}

// ---- dunning dates ----

// Terms are net 30. A reminder goes when payment is due, a second notice
// once it is more than 30 days past due and a final notice once it is more
// than 60, as the CUSDUNN job has always counted them.
const dunningDays = [0, 30, 61, 91];

// dunningDue is when a dunning level is due for an invoice billed then.
export function dunningDue(billed: string, level: number): number {
	return Date.parse(billed) + dunningDays[level] * DAY;
}

// dunningLevelAt is the dunning level an invoice billed then has reached.
export function dunningLevelAt(billed: string, now: number): number {
	let level = 0;
	while (level < 3 && now >= dunningDue(billed, level + 1)) level++;
	return level;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- the workflow ----

// OrderLifecycle runs one order's life. Its steps are named for the turn
// they belong to, so a replay after a restart or a deploy finds each one
// done and carries on from where the order was.
export class OrderLifecycle extends WorkflowEntrypoint<Env, OrderParams> {
	async run(event: Readonly<WorkflowEvent<OrderParams>>, step: WorkflowStep): Promise<string> {
		const { id } = event.payload;
		const retries = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
		for (let turn = 1; turn <= MAX_TURNS; turn++) {
			const look = await step.do(`look ${turn}`, retries, () =>
				event.payload.kind === "P" ? lookAtPO(this.env.DB, id) : lookAtInvoice(this.env.DB, id));
			if (look.done) return look.done;
			let wait = look.wait ?? IDLE;
			if (look.alert) {
				await step.do(`alert ${look.alert}`, retries, () => alertPO(this.env.DB, id, look.alert!));
				continue;
			} else if (look.bill) {
				const billed = await step.do(`bill ${turn}`, retries, () => billOnShipment(this.env, id));
				if (billed) continue;
				wait = RETRY_BILL;
			} else if (look.dun) {
				await step.do(`dun ${look.dun}`, retries, () => dun(this.env, id, look.dun!));
				continue;
			}
			try {
				await step.waitForEvent(`wait ${turn}`, { type: SIGNAL, timeout: wait });
			} catch {
				// Nothing changed before the deadline: look again.
			}
		}
		return "TURNS EXHAUSTED";
	}
}

// recorder collects one look's writes: timeline events, recorded once each,
// and the order's flow row saying what it waits for.
export function recorder(db: D1Database, kind: OrderKind, ref: string, ts: string) {
	const stmts: D1PreparedStatement[] = [];
	const rec = (event: string, key: string, at: string, detail: string, amount: number | null = null, by = "") =>
		stmts.push(db.prepare(
			`INSERT INTO order_timeline (kind, ref, event, key, at, detail, amount, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (kind, ref, event, key) DO NOTHING`,
		).bind(kind, ref, event, key, at || ts, detail.slice(0, 60), amount, by));
	const flow = (look: Look, next: string, nextAt: number | null) => {
		const done = look.done !== undefined;
		stmts.push(db.prepare(
			`INSERT INTO order_flows (kind, ref, status, next, next_at, started, updated, ended, outcome)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
			 ON CONFLICT (kind, ref) DO UPDATE SET status = ?3, next = ?4, next_at = ?5, updated = ?6, ended = ?7, outcome = ?8`,
		).bind(kind, ref, done ? "C" : "W", next, nextAt === null ? "" : new Date(nextAt).toISOString(), ts, done ? ts : "", look.done ?? ""));
		return look;
	};
	return { stmts, rec, flow };
}

// lookAtInvoice records on the timeline what has happened to an invoice,
// decides what the lifecycle does next and notes it on the order's flow.
export async function lookAtInvoice(db: D1Database, id: string, now = Date.now()): Promise<Look> {
	const ts = new Date(now).toISOString();
	const inv = await db.prepare(
		`SELECT i.*, c.name AS cust_name, c.status AS cust_status FROM invoices i
		 LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
	).bind(id).first<Invoice & { cust_name: string | null; cust_status: string | null }>();
	const { stmts, rec, flow } = recorder(db, "I", id, ts);

	if (!inv) {
		rec("CANCELLED", "", ts, "INVOICE CANCELLED, STOCK RETURNED");
		const look = flow({ done: "CANCELLED" }, "", null);
		await db.batch(stmts);
		return look;
	}

	const cust = `${inv.customer_id} ${inv.cust_name ?? ""}`.trim();
	rec("OPENED", "", inv.created, inv.created_by === "EDI" ? `BY 850 FROM ${cust}` : `FOR ${cust}`, null, inv.created_by);

	const shp = await db.prepare("SELECT * FROM shipments WHERE invoice_id = ?").bind(id).first<Shipment>();
	// A shipment cancelled before it shipped put the invoice back to work.
	stmts.push(db.prepare(
		`INSERT INTO order_timeline (kind, ref, event, key, at, detail, by)
		 SELECT kind, ref, 'UNRELEASED', key, ?3, key || ' CANCELLED, INVOICE BACK TO WORK', ''
		 FROM order_timeline WHERE kind = 'I' AND ref = ?1 AND event = 'RELEASED' AND key <> ?2
		 ON CONFLICT (kind, ref, event, key) DO NOTHING`,
	).bind(id, shp?.id ?? "", ts));
	if (shp) {
		rec("RELEASED", shp.id, shp.created, `TO THE WAREHOUSE ON ${shp.id}, PICK TICKET PRINTED`, null, shp.created_by);
		if (shp.packed) rec("PACKED", shp.id, shp.packed, `${shp.cartons} CTN ${shp.weight} LB, ROUTED ${shp.carrier}: ${shp.route}`);
		if (shp.shipped) rec("SHIPPED", shp.id, shp.shipped, `VIA ${shp.carrier} ${shp.tracking}`, null, shp.shipped_by);
		// The carrier's milestones, from its tracking (tracking.ts).
		const { results: scans } = await db.prepare(
			"SELECT at, code, location, detail FROM tracking_events WHERE shipment_id = ? AND code IN ('OUTDLVY', 'EXCEPTION', 'DELIVERED') ORDER BY at",
		).bind(shp.id).all<{ at: string; code: string; location: string; detail: string }>();
		for (const t of scans) {
			if (t.code === "OUTDLVY") rec("OUT FOR DLVY", shp.id, t.at, `${shp.carrier} ${t.location}`.trim(), null, shp.carrier);
			else if (t.code === "EXCEPTION") rec("EXCEPTION", t.at, t.at, t.detail, null, shp.carrier);
			else rec("DELIVERED", shp.id, t.at, shp.signed_by ? `SIGNED BY ${shp.signed_by}` : t.detail, null, shp.carrier);
		}
	}

	// The EDI interchanges about the order: the 850 it came from, the 856
	// and 810 sent for it, and the 820 that paid it.
	const { results: edi } = await db.prepare(
		`SELECT id, direction, type, created, created_by FROM edi
		 WHERE type IN ('850', '856', '810', '820') AND (direction = 'O' OR status = 'ACCEPTED')
		   AND (' ' || reference || ' ') LIKE '% ' || ?1 || ' %'`,
	).bind(id).all<{ id: string; direction: string; type: string; created: string; created_by: string }>();
	const ediNames: Record<string, string> = { "850": "PURCHASE ORDER", "856": "SHIP NOTICE", "810": "INVOICE", "820": "REMITTANCE" };
	for (const e of edi) {
		rec(`EDI ${e.type}`, e.id, e.created, `${e.id} ${ediNames[e.type]} ${e.direction === "O" ? "SENT" : "RECEIVED"}`, null, e.created_by);
	}

	// Lines of its 850 held for an operator, and what became of them.
	const { results: held } = await db.prepare("SELECT * FROM edi_exceptions WHERE invoice_id = ? ORDER BY seq").bind(id)
		.all<{ seq: number; po_line: string; sku: string; problem: string; status: string; corrected_sku: string; created: string; resolved: string; resolved_by: string }>();
	for (const x of held) {
		const what = `PO1 LINE ${x.po_line} ${x.sku || "(NO SKU)"}`;
		rec("EDI HELD", String(x.seq), x.created, `${what}: ${x.problem}`, null, "EDI");
		if (x.status === "C") rec("CORRECTED", String(x.seq), x.resolved, `${what} TO ${x.corrected_sku}`, null, x.resolved_by);
		if (x.status === "D") rec("DROPPED", String(x.seq), x.resolved, `${what} LEFT OFF THE ORDER`, null, x.resolved_by);
	}
	const open = held.filter((x) => x.status === "O").length;

	const { results: txns } = await db.prepare(
		"SELECT type, posted_by FROM transactions WHERE reference = ? AND type IN ('I', 'P')",
	).bind(id).all<{ type: string; posted_by: string }>();
	const by = (t: string) => txns.find((x) => x.type === t)?.posted_by ?? "";
	if (inv.billed) {
		const who = by("I");
		rec("BILLED", "", inv.billed, who === LIFECYCLE ? "ON SHIPMENT, POSTED TO THE ACCOUNT" : "POSTED TO THE ACCOUNT", inv.total, who);
	}
	if (inv.paid) rec("PAID", "", inv.paid, by("P") === "EDI" ? "BY 820 REMITTANCE" : "PAYMENT POSTED", inv.total, by("P"));

	const { results: letters } = await db.prepare("SELECT * FROM dunning WHERE invoice_id = ? ORDER BY level").bind(id)
		.all<{ level: number; days: number; amount: number; sent: string; sent_by: string }>();
	for (const d of letters) {
		rec(dunningLevels[d.level], String(d.level), d.sent, `${d.days} DAYS PAST DUE`, d.amount, d.sent_by);
	}

	let look: Look;
	if (inv.status === "P") {
		look = flow({ done: "PAID" }, "", null);
	} else if (inv.status === "O") {
		if (shp?.status === "S") {
			if (inv.cust_status === "A") look = flow({ bill: true }, "BILLING ON SHIPMENT", now);
			else look = flow({ wait: IDLE }, `BILLING HELD - CUSTOMER ${inv.cust_status === "H" ? "ON HOLD" : "NOT ACTIVE"}`, null);
		} else {
			const next = !shp && open > 0
				? `CORRECTION OF ${open} HELD EDI LINE${open === 1 ? "" : "S"} - OPTION 2.5`
				: !shp
				? "RELEASE TO THE WAREHOUSE"
				: shp.status === "P" ? `PICK AND PACK ${shp.id}` : `SHIP ${shp.id} VIA ${shp.carrier}`;
			look = flow({ wait: IDLE }, next, null);
		}
	} else {
		const sent = letters.reduce((m, d) => Math.max(m, d.level), 0);
		const due = dunningLevelAt(inv.billed, now);
		if (due > sent) {
			look = flow({ dun: due }, `${dunningLevels[due]} DUE NOW`, now);
		} else if (sent < 3) {
			const at = dunningDue(inv.billed, sent + 1);
			const next = sent === 0
				? `PAYMENT DUE ${ymd(at)}, THEN A REMINDER`
				: `PAYMENT, OR ${dunningLevels[sent + 1]} ${ymd(at)}`;
			look = flow({ wait: Math.max(at - now, 1000) }, next, at);
		} else {
			look = flow({ wait: IDLE }, "PAYMENT - ACCOUNT ON HOLD UNTIL PAID", null);
		}
	}
	await db.batch(stmts);
	return look;
}

// billOnShipment bills a shipped invoice, sending its 810 if it came by
// EDI. It reports whether the invoice is billed: if it cannot be (say its
// customer went on hold since the last look), the lifecycle tries again.
export async function billOnShipment(env: Env, id: string): Promise<boolean> {
	const inv = await env.DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(id).first<{ status: string }>();
	if (!inv) return false;
	if (inv.status !== "O") return true; // billed by hand meanwhile
	try {
		const { invoice, edi } = await bill(env.DB, env.TABLES, LIFECYCLE, id);
		await syslog(env.DB, LIFECYCLE,
			`CUS1601I ${id} BILLED ON SHIPMENT, $${invoice.total.toLocaleString("en-US")} TO ${invoice.customer_id}${edi ? ` - 810 ${edi.id} SENT` : ""}`);
		return true;
	} catch (e) {
		if (!(e instanceof HttpError)) throw e;
		await syslog(env.DB, LIFECYCLE, `CUS1602W ${id} NOT BILLED: ${e.message}`.toUpperCase().slice(0, 120));
		return false;
	}
}

// dun sends an invoice's dunning letter for a level: it is recorded once in
// the dunning table, printed and filed in the archive as a PDF, and mailed
// if mail is set up. A final notice puts an active account on hold. A
// letter the CUSDUNN job sent already is left alone.
export async function dun(env: Env, id: string, level: number, now = Date.now()): Promise<string> {
	const db = env.DB;
	const inv = await db.prepare(
		`SELECT i.id, i.customer_id, i.total, i.billed, i.po_number, i.status,
		        c.name, c.address, c.city, c.state, c.zip, c.status AS cust_status
		 FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
	).bind(id).first<Pick<Invoice, "id" | "customer_id" | "total" | "billed" | "po_number" | "status"> &
		Pick<Customer, "name" | "address" | "city" | "state" | "zip"> & { cust_status: string }>();
	if (!inv || inv.status !== "B") return "NOT OWED";
	const days = Math.floor((now - Date.parse(inv.billed)) / DAY) - 30;
	await db.prepare(
		`INSERT INTO dunning (customer_id, invoice_id, level, days, amount, sent, sent_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (invoice_id, level) DO NOTHING`,
	).bind(inv.customer_id, id, level, days, inv.total, new Date(now).toISOString(), LIFECYCLE).run();
	const sent = (await db.prepare("SELECT * FROM dunning WHERE invoice_id = ? AND level = ?").bind(id, level)
		.first<{ days: number; sent: string; sent_by: string }>())!;
	if (sent.sent_by !== LIFECYCLE) return "SENT BY " + sent.sent_by;

	const letter: Letter = {
		level, sent: sent.sent,
		customer: { id: inv.customer_id, name: inv.name, address: inv.address, city: inv.city, state: inv.state, zip: inv.zip },
		invoices: [{ id, po_number: inv.po_number, billed: inv.billed, days: sent.days, total: inv.total }],
	};
	const entry = await putArchive(db, env.ARCHIVE, {
		key: `letters/${sent.sent.slice(0, 10)}/${inv.customer_id}-${id}-L${level}`, kind: "D", ref: inv.customer_id, name: LIFECYCLE,
		title: `${dunningLevels[level]} ${inv.name} ${id}`.slice(0, 60), owner: LIFECYCLE, created: sent.sent, archived_by: LIFECYCLE,
	}, letterLines(letter), letterPdf(letter));
	if (level === 3 && (await holdAccount(db, inv.customer_id, sent.sent, LIFECYCLE))) {
		await db.prepare(
			`INSERT INTO order_timeline (kind, ref, event, key, at, detail, by) VALUES ('I', ?, 'ON HOLD', ?, ?, ?, ?)
			 ON CONFLICT (kind, ref, event, key) DO NOTHING`,
		).bind(id, inv.customer_id, sent.sent, `ACCOUNT ${inv.customer_id} PLACED ON HOLD`, LIFECYCLE).run();
	}
	await syslog(db, LIFECYCLE, `CUS1603I ${dunningLevels[level]} FOR ${id} FILED AS ${entry.key}`.slice(0, 120));
	if (mailable(env)) await mailDocument(env, entry, LIFECYCLE);
	return dunningLevels[level];
}

// ---- delivering signals ----

// deliverSignals hands the outbox's signals to the orders' workflows, at
// most `limit` of them at a time, oldest first. An order with no workflow
// yet gets one; a waiting one is woken; one that failed, or stopped before
// its order was done, is restarted. Signals are removed once delivered, and
// left for the next minute if delivery failed.
export async function deliverSignals(env: Env, limit = 200): Promise<number> {
	const { results } = await env.DB.prepare("SELECT seq, kind, ref, what FROM order_signals ORDER BY seq LIMIT ?")
		.bind(limit).all<{ seq: number; kind: OrderKind; ref: string; what: string }>();
	const byOrder = new Map<string, { kind: OrderKind; ref: string; seq: number; what: string[] }>();
	for (const r of results) {
		const o = byOrder.get(r.kind + r.ref) ?? { kind: r.kind, ref: r.ref, seq: 0, what: [] };
		o.seq = r.seq;
		o.what.push(r.what);
		byOrder.set(r.kind + r.ref, o);
	}
	let delivered = 0;
	for (const o of byOrder.values()) {
		try {
			await deliver(env, o.kind, o.ref, o.what);
			await env.DB.prepare("DELETE FROM order_signals WHERE kind = ? AND ref = ? AND seq <= ?").bind(o.kind, o.ref, o.seq).run();
			delivered++;
		} catch (e) {
			console.error(`delivering signals for ${o.ref}:`, e);
		}
	}
	return delivered;
}

function workflowFor(env: Env, kind: OrderKind): Workflow<OrderParams> | undefined {
	return kind === "I" || kind === "P" ? env.ORDER_FLOW : undefined;
}

async function orderExists(db: D1Database, kind: OrderKind, ref: string): Promise<boolean> {
	const table = kind === "I" ? "invoices" : "purchase_orders";
	return (await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(ref).first()) !== null;
}

async function deliver(env: Env, kind: OrderKind, ref: string, what: string[]): Promise<void> {
	const wf = workflowFor(env, kind);
	if (!wf) return;
	const instance = await wf.get(ref).catch(() => undefined);
	if (!instance) {
		if (!(await orderExists(env.DB, kind, ref))) return; // cancelled before it ever started
		const ts = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO order_flows (kind, ref, status, started, updated) VALUES (?, ?, 'S', ?, ?)
			 ON CONFLICT (kind, ref) DO NOTHING`,
		).bind(kind, ref, ts, ts).run();
		await wf.create({ id: ref, params: { kind, id: ref } });
		return;
	}
	try {
		await instance.sendEvent({ type: SIGNAL, payload: what.join(" ") });
	} catch {
		const { status } = await instance.status();
		const flow = await env.DB.prepare("SELECT status FROM order_flows WHERE kind = ? AND ref = ?").bind(kind, ref).first<{ status: string }>();
		if (status === "complete" && flow?.status === "C") return; // its order is done
		if (status === "errored" || status === "terminated" || status === "complete") await instance.restart();
		else throw new Error(`workflow ${ref} is ${status}`);
	}
}

// ---- reading ----

export async function getFlow(db: D1Database, kind: OrderKind, ref: string): Promise<Flow | undefined> {
	return (await db.prepare("SELECT * FROM order_flows WHERE kind = ? AND ref = ?").bind(kind, ref).first<Flow>()) ?? undefined;
}

// timeline returns an order's events, oldest first.
export async function timeline(db: D1Database, kind: OrderKind, ref: string): Promise<TimelineEvent[]> {
	const { results } = await db.prepare(
		"SELECT * FROM order_timeline WHERE kind = ? AND ref = ? ORDER BY at, seq",
	).bind(kind, ref).all<TimelineEvent>();
	return results;
}

// pendingSignals counts the changes to an order not yet delivered to its
// workflow.
export async function pendingSignals(db: D1Database, kind: OrderKind, ref: string): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM order_signals WHERE kind = ? AND ref = ?").bind(kind, ref).first<{ n: number }>();
	return row?.n ?? 0;
}

// workflowStatus is the order's workflow instance status, such as running
// or waiting, or "" if it has none.
export async function workflowStatus(env: Env, kind: OrderKind, ref: string): Promise<string> {
	const wf = workflowFor(env, kind);
	const instance = wf ? await wf.get(ref).catch(() => undefined) : undefined;
	if (!instance) return "";
	return (await instance.status().catch(() => ({ status: "" }))).status;
}
