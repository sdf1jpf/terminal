// SYSLOG, the system log the operator console shows. Anything can write
// to it: jobs as they start and end, the scheduler, logons, and operator
// commands with their responses.

export type LogType = "M" | "C" | "R"; // message, command, response

export interface LogLine {
	seq: number;
	at: string; // RFC 3339, UTC
	source: string; // a job ID, userid, or SCHEDULR
	type: LogType;
	text: string;
}

// KEEP is how many lines the log keeps; prune drops older ones.
const KEEP = 10_000;

// logStmt is a log write to run in a batch with the change it records.
export function logStmt(db: D1Database, source: string, text: string, type: LogType = "M"): D1PreparedStatement {
	return db.prepare("INSERT INTO syslog (at, source, type, text) VALUES (?, ?, ?, ?)")
		.bind(new Date().toISOString(), source.slice(0, 8), type, text);
}

export async function syslog(db: D1Database, source: string, text: string, type: LogType = "M"): Promise<void> {
	await logStmt(db, source, text, type).run();
}

// tail returns the last n lines, oldest first.
export async function tail(db: D1Database, n: number): Promise<LogLine[]> {
	const { results } = await db.prepare("SELECT * FROM syslog ORDER BY seq DESC LIMIT ?").bind(n).all<LogLine>();
	return results.reverse();
}

// page returns up to n lines from seq on, oldest first.
export async function page(db: D1Database, from: number, n: number): Promise<LogLine[]> {
	const { results } = await db.prepare("SELECT * FROM syslog WHERE seq >= ? ORDER BY seq LIMIT ?").bind(from, n).all<LogLine>();
	return results;
}

// before returns the seq that starts the page of n lines ending just before
// seq, or undefined at the top of the log.
export async function pageBefore(db: D1Database, seq: number, n: number): Promise<number | undefined> {
	const row = await db.prepare(
		"SELECT MIN(seq) AS seq FROM (SELECT seq FROM syslog WHERE seq < ? ORDER BY seq DESC LIMIT ?)",
	).bind(seq, n).first<{ seq: number | null }>();
	return row?.seq ?? undefined;
}

// recent returns up to n lines before seq (or the newest), newest first,
// for GET /v1/syslog.
export async function recent(db: D1Database, before: number, n: number): Promise<LogLine[]> {
	const { results } = await db.prepare("SELECT * FROM syslog WHERE seq < ? ORDER BY seq DESC LIMIT ?")
		.bind(before > 0 ? before : Number.MAX_SAFE_INTEGER, n).all<LogLine>();
	return results;
}

// extent returns how many lines the log has and the seq of the newest.
export async function extent(db: D1Database): Promise<{ lines: number; newest: number }> {
	const row = await db.prepare("SELECT COUNT(*) AS lines, COALESCE(MAX(seq), 0) AS newest FROM syslog")
		.first<{ lines: number; newest: number }>();
	return row ?? { lines: 0, newest: 0 };
}

// prune keeps the newest KEEP lines.
export async function prune(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM syslog WHERE seq <= (SELECT MAX(seq) FROM syslog) - ?").bind(KEEP).run();
}
