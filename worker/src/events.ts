// A customer's event history: everything that happened to the account, in
// one list, newest first. It is read from the records each event left
// behind: the change history (audit), invoices opened, the invoice and
// payment postings (transactions), EDI interchanges with its system,
// shipments released to the warehouse and shipped, and dunning letters.

import { dunningLevels } from "./ledger";

export interface CustomerEvent {
	kind: "A" | "V" | "T" | "E" | "S" | "D"; // audit row, invoice, transaction, EDI interchange, shipment, dunning letter
	key: string; // the audit or transaction seq, or the invoice ID
	at: string; // RFC 3339, UTC
	by: string;
	event: string; // ADDED, CHANGED, DELETED, OPENED, BILLED, INVOICE, PAYMENT, EDI IN, EDI OUT, RELEASED, SHIPPED, DUNNING
	text: string;
	amount?: number; // + charges the account, - credits it
	balance?: number; // after a posting
}

const isInvoice = (ref: string) => /^INV\d{5}$/.test(ref);

export async function customerEvents(db: D1Database, id: string): Promise<CustomerEvent[]> {
	const [audit, invoices, postings, edi, shipments, dunning] = await db.batch<Record<string, string | number>>([
		db.prepare("SELECT * FROM audit WHERE customer_id = ? ORDER BY seq DESC LIMIT 500").bind(id),
		db.prepare("SELECT id, po_number, created, created_by FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 500").bind(id),
		db.prepare("SELECT * FROM transactions WHERE customer_id = ? ORDER BY seq DESC LIMIT 500").bind(id),
		db.prepare("SELECT id, direction, type, status, reference, created, created_by FROM edi WHERE partner = ? ORDER BY id DESC LIMIT 500").bind(id),
		db.prepare("SELECT * FROM shipments WHERE customer_id = ? ORDER BY id DESC LIMIT 500").bind(id),
		db.prepare("SELECT * FROM dunning WHERE customer_id = ? ORDER BY seq DESC LIMIT 500").bind(id),
	]);
	const events: CustomerEvent[] = [];
	for (const r of audit.results) {
		const event = ({ ADD: "ADDED", CHANGE: "CHANGED", DELETE: "DELETED" } as Record<string, string>)[r.action as string] ?? String(r.action);
		const text = r.action === "CHANGE" ? `${r.field} ${r.old_value || "(BLANK)"} > ${r.new_value || "(BLANK)"}` : `RECORD ${event}`;
		events.push({ kind: "A", key: String(r.seq), at: String(r.at), by: String(r.by), event, text });
	}
	for (const r of invoices.results) {
		events.push({
			kind: "V", key: String(r.id), at: String(r.created), by: String(r.created_by), event: "OPENED",
			text: `${r.id}${r.po_number ? ` PO ${r.po_number}` : ""}`,
		});
	}
	for (const r of postings.results) {
		const pay = r.type === "P";
		const ref = String(r.reference);
		events.push({
			kind: "T", key: String(r.seq), at: String(r.posted), by: String(r.posted_by),
			event: pay ? "PAYMENT" : isInvoice(ref) ? "BILLED" : "INVOICE",
			text: ref, amount: pay ? -Number(r.amount) : Number(r.amount), balance: Number(r.balance),
		});
	}
	for (const r of edi.results) {
		events.push({
			kind: "E", key: String(r.id), at: String(r.created), by: String(r.created_by),
			event: r.direction === "I" ? "EDI IN" : "EDI OUT",
			text: `${r.type} ${r.status} ${r.reference}`,
		});
	}
	for (const r of shipments.results) {
		events.push({
			kind: "S", key: String(r.id), at: String(r.created), by: String(r.created_by), event: "RELEASED",
			text: `${r.id} ${r.invoice_id}`,
		});
		if (r.status === "S") {
			events.push({
				kind: "S", key: String(r.id), at: String(r.shipped), by: String(r.shipped_by), event: "SHIPPED",
				text: `${r.id} ${r.carrier} ${r.tracking}`,
			});
		}
	}
	for (const r of dunning.results) {
		events.push({
			kind: "D", key: String(r.seq), at: String(r.sent), by: String(r.sent_by), event: "DUNNING",
			text: `${dunningLevels[Number(r.level)]} ${r.invoice_id} $${Number(r.amount).toLocaleString("en-US")}`,
		});
	}
	// Newest first; at the same instant, the later step first (paid after
	// billed after shipped after opened).
	const order = { A: 0, D: 1, E: 2, V: 3, S: 4, T: 5 };
	return events.sort((a, b) => b.at.localeCompare(a.at) || order[b.kind] - order[a.kind] || Number(b.key.replace(/\D/g, "")) - Number(a.key.replace(/\D/g, "")));
}

// A vendor's event history, or one purchase order's: POs opened, sent and
// received in full, each receipt of goods, and the EDI interchanges with
// the vendor's system (850s out, 855s and 856s in, and the 997s).
export interface VendorEvent {
	kind: "P" | "R" | "E"; // purchase order, receipt, EDI interchange
	key: string; // the PO or interchange ID, or the receipt seq
	po: string; // the purchase order it concerns, if any
	at: string; // RFC 3339, UTC
	by: string;
	event: string; // OPENED, SENT, RECEIPT, RECEIVED, EDI IN, EDI OUT
	text: string;
	amount?: number; // at cost
}

export async function vendorEvents(db: D1Database, vendor: string, po = ""): Promise<VendorEvent[]> {
	const [orders, receipts, edi] = await db.batch<Record<string, string | number>>([
		db.prepare("SELECT * FROM purchase_orders WHERE vendor_id = ?1 AND (?2 = '' OR id = ?2) ORDER BY id DESC LIMIT 500").bind(vendor, po),
		db.prepare(
			`SELECT r.* FROM receipts r JOIN purchase_orders p ON p.id = r.po_id
			 WHERE p.vendor_id = ?1 AND (?2 = '' OR r.po_id = ?2) ORDER BY r.seq DESC LIMIT 500`,
		).bind(vendor, po),
		db.prepare(
			`SELECT id, direction, type, status, reference, created, created_by FROM edi
			 WHERE partner = ?1 AND (?2 = '' OR instr(reference, ?2) > 0) ORDER BY id DESC LIMIT 500`,
		).bind(vendor, po),
	]);
	const events: VendorEvent[] = [];
	for (const r of orders.results) {
		const id = String(r.id);
		events.push({
			kind: "P", key: id, po: id, at: String(r.created), by: String(r.created_by), event: "OPENED",
			text: `${id}${r.origin ? ` BY ${r.origin}` : ""}`,
		});
		if (r.sent) events.push({ kind: "P", key: id, po: id, at: String(r.sent), by: "", event: "SENT", text: id, amount: Number(r.total) });
		if (r.received) events.push({ kind: "P", key: id, po: id, at: String(r.received), by: "", event: "RECEIVED", text: `${id} IN FULL` });
	}
	for (const r of receipts.results) {
		events.push({
			kind: "R", key: String(r.seq), po: String(r.po_id), at: String(r.at), by: String(r.by), event: "RECEIPT",
			text: `${r.po_id} ${r.quantity} ${r.sku}`, amount: Number(r.quantity) * Number(r.unit_cost),
		});
	}
	for (const r of edi.results) {
		events.push({
			kind: "E", key: String(r.id), po: String(r.reference).match(/PO\d{5}/)?.[0] ?? "", at: String(r.created), by: String(r.created_by),
			event: r.direction === "I" ? "EDI IN" : "EDI OUT", text: `${r.type} ${r.status} ${r.reference}`,
		});
	}
	// Newest first; at the same instant, the later step first (received
	// after the receipt, sent after opened).
	const step: Record<string, number> = { OPENED: 0, SENT: 1, "EDI OUT": 2, "EDI IN": 3, RECEIPT: 4, RECEIVED: 5 };
	return events.sort((a, b) => b.at.localeCompare(a.at) || step[b.event] - step[a.event] || Number(b.key.replace(/\D/g, "")) - Number(a.key.replace(/\D/g, "")));
}
