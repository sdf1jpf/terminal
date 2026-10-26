// Email, through Cloudflare Email Routing on the company's domain.
//
// Out: statements, dunning letters and commission statements filed in the
// archive are mailed as PDF attachments (job steps CUSSTMT.STEP020,
// CUSDUNN.STEP020 and CUSCOMM.STEP020). The
// demo's customers are not real, so every message goes to one verified
// address, the binding's destination (MAIL_TO), and names the customer it
// is for. Each archived document is mailed once: a statement is filed per
// customer per month, so customers get one statement a month however often
// CUSSTMT runs.
//
// In: mail to the domain routed to this Worker (the email handler) is read
// as vendor correspondence. A subject naming a purchase order and what
// happened to it, such as "PO00012 CONFIRMED SHIP 2026-11-05" or "PO00012
// SHIPPED", is applied as the vendor's 855 or 856 would be. Everything is
// logged in the mail table, shown on the MAIL LOG screen.

import { archiveFile, kindNames, type Entry } from "./archive";
import { HttpError } from "./http";
import type { Env } from "./index";
import type { Job, StepResult } from "./jobs";
import { vendorDocument } from "./purchasing";
import { logStmt } from "./syslog";

export interface Mail {
	seq: number;
	direction: "O" | "I"; // out, in
	status: "SENT" | "FAILED" | "APPLIED" | "REJECTED";
	sender: string;
	recipient: string;
	subject: string;
	ref: string; // the customer or purchase order it is about
	archive_key: string; // the document attached, for outbound mail
	message_id: string;
	detail: string; // what happened: an error, or what an inbound message did
	at: string; // RFC 3339, UTC
	by: string;
}

export const statusColors: Record<Mail["status"], "green" | "red" | "turquoise" | "yellow"> = {
	SENT: "green", FAILED: "red", APPLIED: "turquoise", REJECTED: "yellow",
};

// mailable reports whether outbound mail is set up: the binding and both
// addresses.
export function mailable(env: Env): boolean {
	return !!(env.MAIL && env.MAIL_FROM && env.MAIL_TO);
}

// mailDocument mails an archived document's PDF, unless it has been sent
// already, and records the attempt. It returns the log row, or undefined if
// it was sent before.
export async function mailDocument(env: Env, e: Entry, by: string): Promise<Mail | undefined> {
	const db = env.DB;
	const sent = await db.prepare("SELECT 1 FROM mail WHERE archive_key = ? AND status = 'SENT'").bind(e.key).first();
	if (sent) return undefined;
	const subject = `${kindNames[e.kind]} ${e.ref} - ${e.title}`.slice(0, 120);
	const name = `${e.key.split("/").slice(1).join("-")}.pdf`;
	const row = { direction: "O", sender: env.MAIL_FROM!, recipient: env.MAIL_TO!, subject, ref: e.ref, archive_key: e.key, by };
	let status: Mail["status"] = "SENT";
	let messageId = "";
	let detail = "";
	try {
		const pdf = await (await archiveFile(env.ARCHIVE, e.key, "pdf")).arrayBuffer();
		const res = await env.MAIL!.send({
			from: { email: env.MAIL_FROM!, name: "CUSTAPI ACCOUNTS RECEIVABLE" },
			to: env.MAIL_TO!,
			subject,
			text: [
				`${kindNames[e.kind]} for ${e.ref}, ${e.title}.`,
				"",
				`The printed copy is attached as ${name}. It is also filed in the`,
				`archive as ${e.key} (option 5.7 on the terminal).`,
				"",
				"This is a demonstration system: mail for every customer comes to this address.",
			].join("\n"),
			attachments: [{ content: pdf, filename: name, type: "application/pdf", disposition: "attachment" }],
		});
		messageId = res.messageId;
	} catch (err) {
		status = "FAILED";
		detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
	}
	return record(db, { ...row, status, message_id: messageId, detail } as Omit<Mail, "seq" | "at">,
		status === "SENT" ? `CUS1520I ${subject} MAILED TO ${env.MAIL_TO}` : `CUS1521E MAIL FOR ${e.ref} FAILED: ${detail}`);
}

async function record(db: D1Database, m: Omit<Mail, "seq" | "at">, log: string): Promise<Mail> {
	const at = new Date().toISOString();
	const [res] = await db.batch<Mail>([
		db.prepare(
			`INSERT INTO mail (direction, status, sender, recipient, subject, ref, archive_key, message_id, detail, at, by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
		).bind(m.direction, m.status, m.sender, m.recipient, m.subject, m.ref, m.archive_key, m.message_id, m.detail, at, m.by),
		logStmt(db, "MAIL", log.toUpperCase().slice(0, 120)),
	]);
	return res.results[0];
}

// mailStep mails the documents of one kind that the job filed in the
// archive, each once. Without mail set up it says so and ends with RC 4.
export function mailStep(kind: "S" | "D" | "M") {
	return async (_db: D1Database, job: Job, env: Env): Promise<StepResult> => {
		const { results } = await env.DB.prepare(
			"SELECT * FROM archive WHERE kind = ? AND archived_by = ? AND archived >= ? ORDER BY key",
		).bind(kind, job.name, job.started || job.submitted).all<Entry>();
		const lines = ["", `MAIL ${kindNames[kind]}S FILED BY THIS RUN:`, ""];
		if (!mailable(env)) {
			lines.push("  MAIL IS NOT SET UP (MAIL BINDING, MAIL_FROM, MAIL_TO) - NOTHING SENT");
			return { rc: 4, lines };
		}
		let sent = 0;
		let failed = 0;
		for (const e of results) {
			const m = await mailDocument(env, e, job.name);
			if (!m) continue;
			if (m.status === "SENT") sent++;
			else failed++;
			lines.push(`  ${m.status.padEnd(6)} ${e.ref.padEnd(8)} ${m.subject.slice(0, 60)}${m.detail ? `  ${m.detail.toUpperCase().slice(0, 40)}` : ""}`);
		}
		if (sent + failed === 0) lines.push("  NOTHING NEW TO MAIL");
		lines.push("", `${sent} MAILED TO ${env.MAIL_TO!.toUpperCase()}, ${failed} FAILED`);
		return { rc: failed ? 8 : 0, lines };
	};
}

export async function listMail(db: D1Database, ref = ""): Promise<Mail[]> {
	const { results } = await db.prepare(
		"SELECT * FROM mail WHERE ?1 = '' OR ref = ?1 ORDER BY seq DESC LIMIT 200",
	).bind(ref.toUpperCase()).all<Mail>();
	return results;
}

export async function getMail(db: D1Database, seq: number): Promise<Mail> {
	const m = await db.prepare("SELECT * FROM mail WHERE seq = ?").bind(seq).first<Mail>();
	if (!m) throw new HttpError(404, "not_found", `no mail ${seq}`);
	return m;
}

// ---- inbound ----

const poSubject = /\b(PO\d{5})\b\s+(CONFIRMED|ACKNOWLEDGED|SHIPPED)(?:\s+(?:SHIP(?:PING)?\s+)?(\d{4}-\d\d-\d\d))?/i;

// receiveMail handles a message routed to the Worker: a vendor confirming
// or shipping a purchase order. Anything else is logged and rejected.
export async function receiveMail(env: Env, msg: ForwardableEmailMessage): Promise<Mail> {
	const subject = (msg.headers.get("subject") ?? "").slice(0, 200);
	const base = { direction: "I" as const, sender: msg.from, recipient: msg.to, subject, archive_key: "", message_id: msg.headers.get("message-id") ?? "", by: "EMAIL" };
	const m = poSubject.exec(subject);
	if (!m) {
		const reason = "subject does not name a purchase order and CONFIRMED or SHIPPED";
		msg.setReject(`Not understood: ${reason}, such as "PO00012 SHIPPED".`);
		return record(env.DB, { ...base, status: "REJECTED", ref: "", detail: reason }, `CUS1522W MAIL FROM ${msg.from} REJECTED - NOT UNDERSTOOD`);
	}
	const id = m[1].toUpperCase();
	const shipped = m[2].toUpperCase() === "SHIPPED";
	try {
		const po = await env.DB.prepare("SELECT vendor_id FROM purchase_orders WHERE id = ?").bind(id).first<{ vendor_id: string }>();
		if (!po) throw new Error(`purchase order ${id} is not on file`);
		const body = shipped ? [["PRF", id]] : [["BAK", "00", "AC", id], ...(m[3] ? [["DTM", "068", m[3].replace(/-/g, "")]] : [])];
		await vendorDocument(env.DB, po.vendor_id, shipped ? "856" : "855", body);
		const did = shipped ? `${id} IN TRANSIT` : `${id} CONFIRMED${m[3] ? `, SHIP ${m[3]}` : ""}`;
		return record(env.DB, { ...base, status: "APPLIED", ref: id, detail: did }, `CUS1523I MAIL FROM ${msg.from}: ${did}`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		msg.setReject(`Not applied: ${reason}.`);
		return record(env.DB, { ...base, status: "REJECTED", ref: id, detail: reason.slice(0, 200) }, `CUS1522W MAIL FROM ${msg.from} ABOUT ${id} REJECTED - ${reason}`);
	}
}
