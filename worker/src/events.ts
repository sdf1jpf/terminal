// A customer's event history: everything that happened to the account, in
// one list, newest first. It is read from the records each event left
// behind: the change history (audit), invoices opened, the invoice and
// payment postings (transactions), EDI interchanges with its system, and
// shipments released to the warehouse and shipped.

export interface CustomerEvent {
	kind: "A" | "V" | "T" | "E" | "S"; // audit row, invoice, transaction, EDI interchange, shipment
	key: string; // the audit or transaction seq, or the invoice ID
	at: string; // RFC 3339, UTC
	by: string;
	event: string; // ADDED, CHANGED, DELETED, OPENED, BILLED, INVOICE, PAYMENT, EDI IN, EDI OUT, RELEASED, SHIPPED
	text: string;
	amount?: number; // + charges the account, - credits it
	balance?: number; // after a posting
}

const isInvoice = (ref: string) => /^INV\d{5}$/.test(ref);

export async function customerEvents(db: D1Database, id: string): Promise<CustomerEvent[]> {
	const [audit, invoices, postings, edi, shipments] = await db.batch<Record<string, string | number>>([
		db.prepare("SELECT * FROM audit WHERE customer_id = ? ORDER BY seq DESC LIMIT 500").bind(id),
		db.prepare("SELECT id, po_number, created, created_by FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 500").bind(id),
		db.prepare("SELECT * FROM transactions WHERE customer_id = ? ORDER BY seq DESC LIMIT 500").bind(id),
		db.prepare("SELECT id, direction, type, status, reference, created, created_by FROM edi WHERE partner = ? ORDER BY id DESC LIMIT 500").bind(id),
		db.prepare("SELECT * FROM shipments WHERE customer_id = ? ORDER BY id DESC LIMIT 500").bind(id),
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
	// Newest first; at the same instant, the later step first (paid after
	// billed after shipped after opened).
	const order = { A: 0, E: 1, V: 2, S: 3, T: 4 };
	return events.sort((a, b) => b.at.localeCompare(a.at) || order[b.kind] - order[a.kind] || Number(b.key.replace(/\D/g, "")) - Number(a.key.replace(/\D/g, "")));
}
