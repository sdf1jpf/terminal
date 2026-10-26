// Purchase order lifecycles. Each purchase order's life, from our 850 to
// goods in stock, runs as an OrderLifecycle workflow named after it, the
// same workflow as invoices' (lifecycle.ts), with kind "P":
//
//	opened (by hand, or by CUSREORD for low stock)
//	  -> sent to the vendor as an 850
//	  -> confirmed by the vendor's 855, with a ship date
//	  -> in transit after its 856
//	  -> received, perhaps in parts, each receipt going into stock
//	  -> received in full: the lifecycle notes the restock and is complete.
//	     A PO cancelled while open ends it too.
//
// The vendors are the ones who must act, so the lifecycle watches the
// clock for them: no 855 within two days of sending, no 856 by the day
// after the promised ship date, or no goods within the vendor's lead time
// (plus two days) of the 856, and it raises an expedite alert on the
// console (SYSLOG) and the PO's timeline, once for each.

import { recorder, type Look } from "./lifecycle";
import type { PurchaseOrder } from "./purchasing";
import { syslog } from "./syslog";

const DAY = 86_400_000;
const IDLE = 30 * DAY;
const ACK_DAYS = 2; // an 855 is due this long after sending
const SHIP_GRACE_DAYS = 1; // an 856 is due this long after the promised ship date
const DELIVERY_GRACE_DAYS = 2; // goods are due this long after lead time from the 856

// The alerts, by key: what is late, for the timeline and the console.
export const poAlerts: Record<string, string> = {
	NOACK: "NO 855 CONFIRMATION FROM THE VENDOR",
	NOTSHIPPED: "NOT SHIPPED BY THE PROMISED DATE",
	NOTDELIVERED: "NOT DELIVERED WITHIN THE LEAD TIME",
};

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// lookAtPO records on the timeline what has happened to a purchase order,
// decides what the lifecycle does next and notes it on the order's flow.
export async function lookAtPO(db: D1Database, id: string, now = Date.now()): Promise<Look> {
	const ts = new Date(now).toISOString();
	const { stmts, rec, flow } = recorder(db, "P", id, ts);
	const po = await db.prepare(
		`SELECT p.*, v.name AS vendor_name, v.lead_days FROM purchase_orders p
		 LEFT JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`,
	).bind(id).first<PurchaseOrder & { vendor_name: string | null; lead_days: number | null }>();
	if (!po) {
		rec("CANCELLED", "", ts, "PURCHASE ORDER CANCELLED");
		const look = flow({ done: "CANCELLED" }, "", null);
		await db.batch(stmts);
		return look;
	}

	const vendor = `${po.vendor_id} ${po.vendor_name ?? ""}`.trim();
	rec("OPENED", "", po.created, `TO ${vendor}${po.origin ? ` BY ${po.origin}` : ""}`, null, po.created_by);
	if (po.sent) rec("SENT", "", po.sent, `TO ${po.vendor_id}`, po.total);

	// The interchanges with the vendor: our 850, its 855 and 856.
	const { results: edi } = await db.prepare(
		`SELECT id, direction, type, created, created_by, raw FROM edi
		 WHERE partner = ?2 AND type IN ('850', '855', '856') AND (direction = 'O' OR status = 'ACCEPTED')
		   AND (' ' || reference || ' ') LIKE '% ' || ?1 || ' %' ORDER BY id`,
	).bind(id, po.vendor_id).all<{ id: string; direction: string; type: string; created: string; created_by: string; raw: string }>();
	const names: Record<string, string> = { "850": "PURCHASE ORDER SENT", "855": "CONFIRMATION RECEIVED", "856": "SHIP NOTICE RECEIVED" };
	for (const e of edi) rec(`EDI ${e.type}`, e.id, e.created, `${e.id} ${names[e.type]}`, null, e.created_by);
	if (po.ship_date) rec("CONFIRMED", "", edi.find((e) => e.type === "855")?.created ?? ts, `SHIP DATE ${po.ship_date}`);
	const asn = edi.find((e) => e.type === "856");
	// A vendor can also confirm or ship by mail (mail.ts); then there is no
	// interchange, and the time of the look stands in for when it happened.
	if (po.status === "T" || po.status === "R") rec("IN TRANSIT", "", asn?.created ?? ts, `FROM ${po.vendor_id}`);

	const { results: receipts } = await db.prepare(
		"SELECT seq, sku, quantity, unit_cost, at, by FROM receipts WHERE po_id = ? ORDER BY seq",
	).bind(id).all<{ seq: number; sku: string; quantity: number; unit_cost: number; at: string; by: string }>();
	for (const r of receipts) rec("RECEIPT", String(r.seq), r.at, `${r.quantity} ${r.sku} INTO STOCK`, r.quantity * r.unit_cost, r.by);

	const { results: alerts } = await db.prepare(
		"SELECT key FROM order_timeline WHERE kind = 'P' AND ref = ? AND event = 'EXPEDITE'",
	).bind(id).all<{ key: string }>();
	const alerted = new Set(alerts.map((a) => a.key));

	// due waits for something the vendor owes by a deadline, then alerts once.
	const due = (key: string, by: number, next: string): Look => {
		if (alerted.has(key)) return flow({ wait: IDLE }, `${next} - ${poAlerts[key]}`, null);
		if (now >= by) return flow({ alert: key }, `EXPEDITE: ${poAlerts[key]}`, now);
		return flow({ wait: Math.max(by - now, 1000) }, `${next} BY ${ymd(by)}`, by);
	};

	let look: Look;
	if (po.status === "R") {
		const units = receipts.reduce((n, r) => n + r.quantity, 0);
		rec("RECEIVED", "", po.received, `IN FULL, ${units} UNITS RESTOCKED`, po.total);
		look = flow({ done: "RECEIVED" }, "", null);
	} else if (po.status === "O") {
		look = flow({ wait: IDLE }, `SEND TO ${po.vendor_id}`, null);
	} else if (po.status === "S") {
		look = due("NOACK", Date.parse(po.sent) + ACK_DAYS * DAY, `855 FROM ${po.vendor_id}`);
	} else if (po.status === "A") {
		const promised = po.ship_date ? Date.parse(`${po.ship_date}T00:00:00Z`) : Date.parse(po.sent) + (po.lead_days ?? 5) * DAY;
		look = due("NOTSHIPPED", promised + SHIP_GRACE_DAYS * DAY, `856 FROM ${po.vendor_id}`);
	} else {
		const shipped = asn ? Date.parse(asn.created) : now;
		const left = receipts.length ? "THE REST OF THE GOODS" : "THE GOODS";
		look = due("NOTDELIVERED", shipped + ((po.lead_days ?? 5) + DELIVERY_GRACE_DAYS) * DAY, left);
	}
	await db.batch(stmts);
	return look;
}

// alertPO raises an expedite alert for a late purchase order, once.
export async function alertPO(db: D1Database, id: string, key: string): Promise<void> {
	const ts = new Date().toISOString();
	const res = await db.prepare(
		`INSERT INTO order_timeline (kind, ref, event, key, at, detail, by) VALUES ('P', ?, 'EXPEDITE', ?, ?, ?, 'CUSORDER')
		 ON CONFLICT (kind, ref, event, key) DO NOTHING`,
	).bind(id, key, ts, poAlerts[key] ?? key).run();
	if (res.meta.changes === 0) return;
	const v = await db.prepare("SELECT vendor_id FROM purchase_orders WHERE id = ?").bind(id).first<{ vendor_id: string }>();
	await syslog(db, "CUSORDER", `CUS1620W EXPEDITE ${id} ${v?.vendor_id ?? ""}: ${poAlerts[key] ?? key}`.slice(0, 120));
}
