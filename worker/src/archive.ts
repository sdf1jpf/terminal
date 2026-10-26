// The archive, in R2. Output that has been on the spool more than a week
// moves here (job CUSARCH), as do the documents the batch jobs produce:
// statements, dunning letters and the month-end reports. Each entry is a
// row in D1, for the screens and listings, and two objects in the bucket:
// <key>.txt with the lines and <key>.pdf, the printed copy. A listing can
// be restored to the spool, held, under its original ID.

import { listingPdf } from "./documents";
import { HttpError } from "./http";
import { getOutput, spoolStmts, type Output } from "./spool";
import { logStmt } from "./syslog";

export type Kind = "L" | "M" | "S" | "D";

export const kindNames: Record<Kind, string> = { L: "LISTING", M: "MONTH-END", S: "STATEMENT", D: "DUNNING" };

export interface Entry {
	key: string;
	kind: Kind;
	ref: string;
	name: string;
	title: string;
	owner: string;
	lines: number;
	bytes: number;
	created: string;
	archived: string;
	archived_by: string;
}

// RETENTION_DAYS is how long output stays on the spool before CUSARCH
// archives it.
export const RETENTION_DAYS = 7;

// putArchive writes an entry's text and PDF to the bucket and records it,
// replacing what was there under the same key.
export async function putArchive(
	db: D1Database,
	bucket: R2Bucket,
	e: Omit<Entry, "lines" | "bytes" | "archived">,
	lines: string[],
	pdf: Uint8Array,
): Promise<Entry> {
	const meta = { kind: e.kind, ref: e.ref, name: e.name, title: e.title, owner: e.owner, created: e.created };
	await Promise.all([
		bucket.put(`${e.key}.txt`, lines.join("\n") + "\n", {
			httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: meta,
		}),
		bucket.put(`${e.key}.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: meta }),
	]);
	const entry: Entry = { ...e, lines: lines.length, bytes: pdf.length, archived: new Date().toISOString() };
	await db.prepare(
		`INSERT OR REPLACE INTO archive (key, kind, ref, name, title, owner, lines, bytes, created, archived, archived_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(entry.key, entry.kind, entry.ref, entry.name, entry.title, entry.owner, entry.lines, entry.bytes,
		entry.created, entry.archived, entry.archived_by).run();
	return entry;
}

// listArchive returns archived entries, newest first: name filters by a
// name or reference prefix, kind by kind.
export async function listArchive(db: D1Database, name = "", kind = ""): Promise<Entry[]> {
	const like = name.toUpperCase().replace(/[\\%_]/g, "\\$&") + "%";
	const { results } = await db.prepare(
		`SELECT * FROM archive WHERE (name LIKE ?1 ESCAPE '\\' OR ref LIKE ?1 ESCAPE '\\') AND (?2 = '' OR kind = ?2)
		 ORDER BY archived DESC, key DESC LIMIT 500`,
	).bind(like, kind.toUpperCase()).all<Entry>();
	return results;
}

export async function getEntry(db: D1Database, key: string): Promise<Entry> {
	const e = await db.prepare("SELECT * FROM archive WHERE key = ?").bind(key).first<Entry>();
	if (!e) throw notArchived(key);
	return e;
}

// archiveFile returns one of an entry's objects, "txt" or "pdf".
export async function archiveFile(bucket: R2Bucket, key: string, ext: "txt" | "pdf"): Promise<R2ObjectBody> {
	const obj = await bucket.get(`${key}.${ext}`);
	if (!obj) throw notArchived(key);
	return obj;
}

export async function archiveLines(bucket: R2Bucket, key: string): Promise<string[]> {
	const text = await (await archiveFile(bucket, key, "txt")).text();
	return text.replace(/\n$/, "").split("\n");
}

// restoreArchive puts an archived listing back on the spool, held.
export async function restoreArchive(db: D1Database, bucket: R2Bucket, user: string, key: string): Promise<Output> {
	const e = await getEntry(db, key);
	if (e.kind !== "L") throw new HttpError(422, "invalid", `${e.ref} is a ${kindNames[e.kind].toLowerCase()}, not spool output: only listings go back on the spool`);
	const there = await db.prepare("SELECT 1 FROM spool WHERE id = ?").bind(e.ref).first();
	if (there) throw new HttpError(409, "conflict", `${e.ref} is already on the spool`);
	const lines = await archiveLines(bucket, key);
	await db.batch([
		...spoolStmts(db, { id: e.ref, name: e.name, owner: e.owner, title: e.title }, lines),
		db.prepare("UPDATE spool SET created = ? WHERE id = ?").bind(e.created, e.ref),
		logStmt(db, e.ref, `$HASP101 ${e.name} ${e.ref} RESTORED FROM ARCHIVE BY ${user}`.slice(0, 120)),
	]);
	return (await getOutput(db, e.ref)).output;
}

// spoolKey is where an output group is archived: by the month it was made.
export function spoolKey(o: Pick<Output, "id" | "created">): string {
	return `spool/${o.created.slice(0, 7)}/${o.id}`;
}

// archiveSpool moves output older than the retention period off the spool
// and into the archive, at most `limit` groups a run. Each group is written
// to the bucket before it is purged, so a retried run never loses one.
export async function archiveSpool(db: D1Database, bucket: R2Bucket, by: string, now = Date.now(), limit = 100): Promise<Entry[]> {
	const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
	const { results } = await db.prepare(
		"SELECT * FROM spool WHERE created < ? ORDER BY created, id LIMIT ?",
	).bind(cutoff, limit).all<Output>();
	const done: Entry[] = [];
	for (const o of results) {
		const { lines } = await getOutput(db, o.id);
		const entry = await putArchive(db, bucket, {
			key: spoolKey(o), kind: "L", ref: o.id, name: o.name, title: o.title, owner: o.owner, created: o.created, archived_by: by,
		}, lines, listingPdf(o, lines));
		await db.batch([
			db.prepare("DELETE FROM spool_lines WHERE spool_id = ?").bind(o.id),
			db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'OUTPUT'").bind(o.id),
			db.prepare("DELETE FROM spool WHERE id = ?").bind(o.id),
			logStmt(db, o.id, `$HASP250 ${o.name} ${o.id} ARCHIVED TO ${entry.key}`.slice(0, 120)),
		]);
		done.push(entry);
	}
	return done;
}

function notArchived(key: string): HttpError {
	return new HttpError(404, "not_found", `${key} is not in the archive`);
}
