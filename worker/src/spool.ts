// The print spool, JES style. Every job's output listing, and each report
// printed from a screen, is held on the spool as an output group until an
// operator prints or purges it. A job's output has the job's ID; a report
// printed online gets a TSU ID, as output from a TSO session would.
// Printing sends a copy to the printer, PRT1, which here means it is
// counted, logged and can be fetched as paged text (GET /v1/spool/{id}/print).

import { HttpError } from "./http";
import { logStmt } from "./syslog";

export const PRINTER = "PRT1";

export interface Output {
	id: string; // JOB00001 or TSU00001
	name: string; // the job name, or the panel a report came from
	owner: string;
	title: string;
	status: "HELD" | "PRINTED";
	lines: number;
	copies: number; // how many times it has been printed
	created: string; // RFC 3339, UTC
	printed: string; // the last time
	printed_by: string;
}

// spoolStmts writes an output group and its lines, replacing any that
// was there (a job step retried writes its output again).
export function spoolStmts(
	db: D1Database,
	o: Pick<Output, "id" | "name" | "owner" | "title">,
	lines: string[],
): D1PreparedStatement[] {
	return [
		db.prepare("DELETE FROM spool_lines WHERE spool_id = ?").bind(o.id),
		db.prepare(
			`INSERT OR REPLACE INTO spool (id, name, owner, title, status, lines, created) VALUES (?, ?, ?, ?, 'HELD', ?, ?)`,
		).bind(o.id, o.name, o.owner, o.title, lines.length, new Date().toISOString()),
		db.prepare("INSERT INTO spool_lines (spool_id, line, text) SELECT ?, key + 1, value FROM json_each(?)")
			.bind(o.id, JSON.stringify(lines)),
	];
}

// listOutput returns the spool, newest first; name filters by a name prefix.
export async function listOutput(db: D1Database, name = ""): Promise<Output[]> {
	const { results } = await db.prepare(
		"SELECT * FROM spool WHERE name LIKE ? ESCAPE '\\' ORDER BY created DESC, id DESC LIMIT 200",
	).bind(name.toUpperCase().replace(/[\\%_]/g, "\\$&") + "%").all<Output>();
	return results;
}

export async function getOutput(db: D1Database, id: string): Promise<{ output: Output; lines: string[] }> {
	const [head, body] = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT * FROM spool WHERE id = ?").bind(id),
		db.prepare("SELECT text FROM spool_lines WHERE spool_id = ? ORDER BY line").bind(id),
	]);
	const output = head.results[0] as unknown as Output | undefined;
	if (!output) throw notOnSpool(id);
	return { output, lines: body.results.map((r) => String(r.text)) };
}

// lines returns an output group's lines, or undefined if it is not on the
// spool (never written, or purged).
export async function outputLines(db: D1Database, id: string): Promise<string[] | undefined> {
	try {
		return (await getOutput(db, id)).lines;
	} catch (e) {
		if (e instanceof HttpError && e.code === "not_found") return undefined;
		throw e;
	}
}

// printOutput sends a copy of an output group to the printer.
export async function printOutput(db: D1Database, user: string, id: string): Promise<Output> {
	const [res] = await db.batch<Output>([
		db.prepare(
			"UPDATE spool SET status = 'PRINTED', copies = copies + 1, printed = ?, printed_by = ? WHERE id = ? RETURNING *",
		).bind(new Date().toISOString(), user, id),
		db.prepare(
			`INSERT INTO syslog (at, source, type, text)
			 SELECT ?, ?, 'M', '$HASP150 ' || name || ' ON ${PRINTER} ' || lines || ' LINES FOR ' || ? FROM spool WHERE id = ?`,
		).bind(new Date().toISOString(), id, user, id),
	]);
	const out = res.results[0];
	if (!out) throw notOnSpool(id);
	return out;
}

// purgeOutput takes an output group off the spool, and a job with it, as
// SDSF's P does.
export async function purgeOutput(db: D1Database, user: string, id: string): Promise<void> {
	const [, , , res] = await db.batch([
		db.prepare(
			`INSERT INTO syslog (at, source, type, text)
			 SELECT ?, ?, 'M', '$HASP250 ' || name || ' PURGED BY ' || ? FROM spool WHERE id = ?`,
		).bind(new Date().toISOString(), id, user.slice(0, 8), id),
		db.prepare("DELETE FROM spool_lines WHERE spool_id = ?").bind(id),
		db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'OUTPUT'").bind(id),
		db.prepare("DELETE FROM spool WHERE id = ?").bind(id),
	]);
	if (res.meta.changes === 0) throw notOnSpool(id);
}

// spoolReport puts a report printed from a screen on the spool, held, and
// returns its TSU ID.
export async function spoolReport(db: D1Database, user: string, name: string, title: string, lines: string[]): Promise<string> {
	const row = await db.prepare(
		"UPDATE counters SET value = value + 1 WHERE name = 'tsu_id' RETURNING printf('TSU%05d', value) AS id",
	).first<{ id: string }>();
	const id = row!.id;
	await db.batch([
		...spoolStmts(db, { id, name, owner: user, title }, lines),
		logStmt(db, id, `$HASP101 ${name} ${title} HELD FOR ${user}`.slice(0, 120)),
	]);
	return id;
}

// LINES_PER_PAGE is 60, for 11-inch paper at 6 lines per inch.
const LINES_PER_PAGE = 60;

// printPages lays an output group out for the printer, a page at a time,
// with a heading on each page.
export function printPages(o: Pick<Output, "id" | "name" | "title">, lines: string[]): string[][] {
	const per = LINES_PER_PAGE - 3;
	const pages = Math.max(Math.ceil(lines.length / per), 1);
	const head = `${o.name.padEnd(8)} ${o.id}  ${o.title}`.slice(0, 110);
	return Array.from({ length: pages }, (_, p) => [
		`${head.padEnd(120)}PAGE ${String(p + 1).padStart(4)}`, "", "",
		...lines.slice(p * per, (p + 1) * per),
	]);
}

// printText is the printer's copy as text, with a form feed between pages.
export function printText(o: Pick<Output, "id" | "name" | "title">, lines: string[]): string {
	return printPages(o, lines).map((p) => p.join("\n")).join("\n\f") + "\n";
}

function notOnSpool(id: string): HttpError {
	return new HttpError(404, "not_found", `${id} is not on the spool`);
}
