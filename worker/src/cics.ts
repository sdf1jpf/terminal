// CICS-style transactions. Every screen belongs to a four-character
// transaction, such as CINQ for customer inquiry, which can be started by
// its ID from the clear screen or any menu, disabled with CEMT, and counts
// its uses and abends. Temporary storage queues hold the abend log (CSMT)
// and the EDF trace of each terminal (CEDFtttt); CEBR browses them.

import { AiError } from "./ai";
import { HttpError } from "./http";
import { logStmt } from "./syslog";

export interface Transaction {
	id: string;
	program: string; // the program name CEMT and CEDF show
	desc: string;
	path?: string; // the menu fast path it starts, such as 1.2
	panels?: string[]; // the panels that run under it
	system?: boolean; // a CICS-supplied transaction: cannot be disabled
}

export const transactions: Transaction[] = [
	{ id: "MENU", program: "CUSMENU", desc: "PRIMARY OPTION MENU", path: "", panels: ["menu"], system: true },
	{ id: "CBRW", program: "CUSBRW", desc: "CUSTOMER BROWSE", path: "1.1", panels: ["browse"] },
	{ id: "CINQ", program: "CUSDTL", desc: "CUSTOMER INQUIRY", path: "1.2", panels: ["detail"] },
	{ id: "CADD", program: "CUSDTL", desc: "ADD A CUSTOMER", path: "1.3" },
	{ id: "CEVT", program: "CUSEVT", desc: "CUSTOMER EVENT HISTORY", path: "1.4", panels: ["activity", "event"] },
	{ id: "FIND", program: "CUSFIND", desc: "SEARCH", path: "1.5", panels: ["search"] },
	{ id: "ORDR", program: "CUSINV", desc: "INVOICES", path: "2.1", panels: ["invoices", "invoice", "invaddr", "skusearch"] },
	{ id: "SHIP", program: "CUSSHP", desc: "SHIPPING", path: "2.2", panels: ["shipments", "shipment"] },
	{ id: "EDIM", program: "CUSEDI", desc: "EDI MAILBOX", path: "2.3", panels: ["edi", "edidoc"] },
	{ id: "TIME", program: "CUSTML", desc: "ORDER TIMELINE", path: "2.4", panels: ["timeline"] },
	{ id: "EDIX", program: "CUSEDX", desc: "EDI EXCEPTIONS", path: "2.5", panels: ["ediex"] },
	{ id: "TRAK", program: "CUSTRK", desc: "SHIPMENT TRACKING", path: "2.6", panels: ["tracking"] },
	{ id: "INVQ", program: "CUSPRD", desc: "PRODUCTS AND STOCK", path: "3.1", panels: ["products", "product"] },
	{ id: "PURC", program: "CUSPUR", desc: "PURCHASE ORDERS", path: "3.2", panels: ["pos", "po"] },
	{ id: "VEND", program: "CUSVND", desc: "VENDORS", path: "3.3", panels: ["vendors", "vendhist"] },
	{ id: "GLED", program: "CUSGL", desc: "GENERAL LEDGER", path: "4.1", panels: ["ledger", "glaccount"] },
	{ id: "RPTS", program: "CUSRPT", desc: "REPORTS", path: "4.2", panels: ["chart", "report"] },
	{ id: "JOBS", program: "CUSJOB", desc: "BATCH JOBS", path: "5.1", panels: ["jobs", "joblog"] },
	{ id: "CONS", program: "CUSCON", desc: "OPERATOR CONSOLE", path: "5.2", panels: ["console", "schedule"] },
	{ id: "SPOL", program: "CUSSPL", desc: "HELD OUTPUT", path: "5.4", panels: ["spool", "output"] },
	{ id: "MNTR", program: "CUSMON", desc: "TRANSACTION MONITOR", path: "5.5", panels: ["monitor"] },
	{ id: "TABL", program: "CUSTBL", desc: "SYSTEM TABLES", path: "5.6", panels: ["tables", "tablerows", "tablerow"] },
	{ id: "ARCH", program: "CUSARC", desc: "OUTPUT ARCHIVE", path: "5.7", panels: ["archive", "archdoc"] },
	{ id: "MAIL", program: "CUSMAI", desc: "MAIL", path: "5.8", panels: ["mail", "mailmsg"] },
	{ id: "PRIC", program: "CUSPRC", desc: "PRICING AND PROMOTIONS", path: "6.1", panels: ["pricing", "breaks", "promos"] },
	{ id: "SALE", program: "CUSSLS", desc: "TERRITORIES AND COMMISSIONS", path: "6.2", panels: ["territories", "salespeople", "salesrpt"] },
	{ id: "FLET", program: "CUSFLT", desc: "TRUCKS AND DRIVERS", path: "7.1", panels: ["trucks", "drivers", "fleetitem"] },
	{ id: "LOAD", program: "CUSLOD", desc: "LOADS AND DISPATCH", path: "7.3", panels: ["loads", "load", "board", "costs"] },
	{ id: "HELP", program: "CUSHLP", desc: "TUTORIAL AND HELP", path: "T", panels: ["ask"] },
	{ id: "CEMT", program: "DFHEMTP", desc: "MASTER TERMINAL", system: true },
	{ id: "CEDF", program: "DFHEDFP", desc: "EXECUTION DIAGNOSTIC FACILITY", system: true },
	{ id: "CEBR", program: "DFHEDFBR", desc: "TEMPORARY STORAGE BROWSE", system: true },
	{ id: "CESF", program: "DFHSFP", desc: "SIGN OFF", system: true },
];

export const byId = new Map(transactions.map((t) => [t.id, t]));

const panelTran = new Map<string, Transaction>();
for (const t of transactions) for (const p of t.panels ?? []) panelTran.set(p, t);

// The panels of the CICS transactions themselves, which run outside the
// application's transactions: no use counts, no EDF.
export const systemPanels = new Set(["cics", "cemt", "cedf", "cebr", "abend"]);

// tranOf is the transaction a screen runs under. Help runs under the
// screen it was asked from.
export function tranOf(s: { p: string; back?: unknown }): Transaction | undefined {
	for (let st: { p: string; back?: unknown } | undefined = s; st; st = st.back as typeof st) {
		const t = panelTran.get(st.p);
		if (t || st.p !== "help") return t;
	}
	return undefined;
}

// --- Status and statistics ---

export interface TranStats {
	status: "ENABLED" | "DISABLED";
	uses: number;
	abends: number;
	last_used: string | null;
	last_abend: string | null;
}

const fresh: TranStats = { status: "ENABLED", uses: 0, abends: 0, last_used: null, last_abend: null };

export async function tranStats(db: D1Database): Promise<Map<string, TranStats>> {
	const { results } = await db.prepare("SELECT tranid, status, uses, abends, last_used, last_abend FROM cics_transactions")
		.all<TranStats & { tranid: string }>();
	const rows = new Map(results.map((r) => [r.tranid, r]));
	return new Map(transactions.map((t) => [t.id, rows.get(t.id) ?? fresh]));
}

export async function setStatus(db: D1Database, id: string, status: "ENABLED" | "DISABLED"): Promise<void> {
	await db.prepare(
		"INSERT INTO cics_transactions (tranid, status) VALUES (?1, ?2) ON CONFLICT (tranid) DO UPDATE SET status = ?2",
	).bind(id, status).run();
}

// stepInfo is what the screen engine needs to know before showing a screen
// of transaction id: whether it is disabled, and whether this terminal is
// in EDF mode. One query, as it runs on every step.
export async function stepInfo(db: D1Database, id: string, user: string, terminal: string): Promise<{ disabled: boolean; edf: boolean }> {
	const row = await db.prepare(
		`SELECT (SELECT status FROM cics_transactions WHERE tranid = ?1) AS status,
			EXISTS (SELECT 1 FROM cics_edf WHERE user = ?2 AND terminal = ?3) AS edf`,
	).bind(id, user, terminal).first<{ status: string | null; edf: number }>();
	return { disabled: row?.status === "DISABLED", edf: !!row?.edf };
}

export function countUse(db: D1Database, id: string): Promise<unknown> {
	return db.prepare(
		`INSERT INTO cics_transactions (tranid, uses, last_used) VALUES (?1, 1, ?2)
		ON CONFLICT (tranid) DO UPDATE SET uses = uses + 1, last_used = ?2`,
	).bind(id, new Date().toISOString()).run();
}

export async function nextTask(db: D1Database): Promise<number> {
	const row = await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'cics_task' RETURNING value").first<{ value: number }>();
	return row?.value ?? 0;
}

// --- EDF ---

export async function setEdf(db: D1Database, user: string, terminal: string, on: boolean): Promise<void> {
	if (on) {
		await db.prepare("INSERT OR REPLACE INTO cics_edf (user, terminal, since) VALUES (?, ?, ?)")
			.bind(user, terminal, new Date().toISOString()).run();
	} else {
		await db.prepare("DELETE FROM cics_edf WHERE user = ? AND terminal = ?").bind(user, terminal).run();
	}
}

// edfQueue names a terminal's EDF trace queue: CEDF and the last four
// characters of its terminal ID, as CICS terminal IDs are four long.
export const termId = (terminal: string) => terminal.slice(-4).toUpperCase();
export const edfQueue = (terminal: string) => "CEDF" + termId(terminal);

// --- Abends ---

export interface Abend { code: string; text: string }

// abendCode turns what a program threw into a CICS abend code: AEIM for a
// record not found, AEIP for an invalid request, AEY9 when Workers AI is
// unavailable and ASRA, a program check, for anything else.
export function abendCode(e: unknown): Abend {
	const text = e instanceof Error ? e.message : String(e);
	if (e instanceof HttpError) return { code: e.status === 404 ? "AEIM" : "AEIP", text };
	if (e instanceof AiError) return { code: "AEY9", text };
	return { code: "ASRA", text };
}

// logAbend counts the abend against its transaction and writes it to the
// CSMT queue and SYSLOG.
export async function logAbend(db: D1Database, user: string, terminal: string, tranid: string, panel: string, a: Abend): Promise<void> {
	const now = new Date().toISOString();
	const line = `${now.slice(0, 19).replace("T", " ")} ${termId(terminal)} ${user} ${tranid} ABEND ${a.code} ${panel}: ${a.text}`;
	await db.batch([
		db.prepare(
			`INSERT INTO cics_transactions (tranid, abends, last_abend) VALUES (?1, 1, ?2)
			ON CONFLICT (tranid) DO UPDATE SET abends = abends + 1, last_abend = ?2`,
		).bind(tranid, a.code),
		writeqStmt(db, "CSMT", line, now),
		logStmt(db, user, `DFHAC2206 TRANSACTION ${tranid} FAILED WITH ABEND ${a.code} ON ${termId(terminal)}`),
		trimStmt(db, "CSMT"),
	]);
}

// --- Temporary storage queues ---

const QUEUE_ITEMS = 500; // the newest items a queue keeps

export interface QueueInfo { queue: string; items: number; written: string }

function writeqStmt(db: D1Database, queue: string, data: string, now = new Date().toISOString()): D1PreparedStatement {
	return db.prepare(
		"INSERT INTO cics_tsq (queue, item, data, written) SELECT ?1, COALESCE(MAX(item), 0) + 1, ?2, ?3 FROM cics_tsq WHERE queue = ?1",
	).bind(queue, data, now);
}

function trimStmt(db: D1Database, queue: string): D1PreparedStatement {
	return db.prepare(
		"DELETE FROM cics_tsq WHERE queue = ?1 AND item <= (SELECT MAX(item) FROM cics_tsq WHERE queue = ?1) - ?2",
	).bind(queue, QUEUE_ITEMS);
}

export async function writeq(db: D1Database, queue: string, data: string): Promise<void> {
	await db.batch([writeqStmt(db, queue, data), trimStmt(db, queue)]);
}

export async function queues(db: D1Database): Promise<QueueInfo[]> {
	const { results } = await db.prepare(
		"SELECT queue, COUNT(*) AS items, MAX(written) AS written FROM cics_tsq GROUP BY queue ORDER BY queue",
	).all<QueueInfo>();
	return results;
}

// readq returns n items of a queue from the from'th (counting from 0), and
// how many it holds.
export async function readq(db: D1Database, queue: string, from: number, n: number): Promise<{ items: string[]; total: number }> {
	const [rows, count] = await db.batch<{ data?: string; total?: number }>([
		db.prepare("SELECT data FROM cics_tsq WHERE queue = ? ORDER BY item LIMIT ? OFFSET ?").bind(queue, n, from),
		db.prepare("SELECT COUNT(*) AS total FROM cics_tsq WHERE queue = ?").bind(queue),
	]);
	return { items: rows.results.map((r) => r.data ?? ""), total: count.results[0]?.total ?? 0 };
}

export async function deleteq(db: D1Database, queue: string): Promise<number> {
	const r = await db.prepare("DELETE FROM cics_tsq WHERE queue = ?").bind(queue).run();
	return r.meta.changes ?? 0;
}
