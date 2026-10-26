// The transaction monitor, like CICS statistics: every request is written
// to Workers Analytics Engine as a data point, and the monitor screen and
// GET /v1/monitor read them back with its SQL API.
//
// A data point, in the customer_transactions dataset:
//
//	index1   the transaction: the screen map sent (CUSM00) or the API route
//	blob1    the transaction again (indexes cannot be selected)
//	blob2    SCREEN or API
//	blob3    the userid ("" before sign-on)
//	blob4    the terminal, for screens
//	double1  response time, milliseconds
//	double2  HTTP status
//	double3  1 for an abend (status 500 and up), else 0
//
// Analytics Engine samples busy indexes, so counts are weighted by
// _sample_interval. Reading needs an API token with Account Analytics Read
// (the AE_API_TOKEN secret); writing needs only the binding.

import type { Env } from "./index";
import { HttpError } from "./http";

export const DATASET = "customer_transactions";

export interface Txn {
	tran: string;
	kind: "SCREEN" | "API";
	user: string;
	terminal: string;
	ms: number;
	status: number;
}

// record writes a transaction. It never fails the request it measures.
export function record(env: Env, t: Txn): void {
	try {
		env.TXN?.writeDataPoint({
			indexes: [t.tran.slice(0, 96)],
			blobs: [t.tran, t.kind, t.user, t.terminal],
			doubles: [t.ms, t.status, t.status >= 500 ? 1 : 0],
		});
	} catch (e) {
		console.error("transaction monitor:", e);
	}
}

export interface TranStats {
	tran: string;
	kind: string;
	count: number;
	avg_ms: number;
	max_ms: number;
	p95_ms: number;
	abends: number;
}

export interface Interval {
	at: string; // RFC 3339, the start of the interval
	count: number;
	avg_ms: number;
	abends: number;
}

export interface Stats {
	minutes: number; // the window
	bucket: number; // minutes per interval
	total: { count: number; tpm: number; avg_ms: number; max_ms: number; abends: number };
	trans: TranStats[];
	intervals: Interval[]; // newest first
}

export const windows = [5, 15, 60, 240, 1440];

// stats summarises the last `minutes` of transactions, by transaction and
// in `buckets` intervals.
export async function stats(env: Env, minutes: number, buckets = 12): Promise<Stats> {
	if (!windows.includes(minutes)) throw new HttpError(400, "bad_request", `minutes must be one of ${windows.join(", ")}`);
	const bucket = Math.max(1, Math.ceil(minutes / buckets));
	const since = `timestamp > NOW() - INTERVAL '${minutes}' MINUTE`;
	const weighted = (d: string) => `SUM(_sample_interval * ${d}) / SUM(_sample_interval)`;
	const [trans, intervals] = await Promise.all([
		query(env, `SELECT blob1 AS tran, blob2 AS kind, SUM(_sample_interval) AS count, ${weighted("double1")} AS avg_ms,
			MAX(double1) AS max_ms, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms,
			SUM(_sample_interval * double3) AS abends
			FROM ${DATASET} WHERE ${since} GROUP BY tran, kind ORDER BY count DESC LIMIT 200`),
		query(env, `SELECT toStartOfInterval(timestamp, INTERVAL '${bucket}' MINUTE) AS at, SUM(_sample_interval) AS count,
			${weighted("double1")} AS avg_ms, SUM(_sample_interval * double3) AS abends
			FROM ${DATASET} WHERE ${since} GROUP BY at ORDER BY at DESC LIMIT ${buckets + 1}`),
	]);
	const t = trans.map((r) => ({
		tran: String(r.tran), kind: String(r.kind), count: num(r.count), avg_ms: num(r.avg_ms),
		max_ms: num(r.max_ms), p95_ms: num(r.p95_ms), abends: num(r.abends),
	}));
	const count = t.reduce((n, r) => n + r.count, 0);
	return {
		minutes,
		bucket,
		total: {
			count,
			tpm: count / minutes,
			avg_ms: count ? t.reduce((n, r) => n + r.avg_ms * r.count, 0) / count : 0,
			max_ms: Math.max(0, ...t.map((r) => r.max_ms)),
			abends: t.reduce((n, r) => n + r.abends, 0),
		},
		trans: t,
		intervals: intervals.map((r) => ({ at: isoTime(String(r.at)), count: num(r.count), avg_ms: num(r.avg_ms), abends: num(r.abends) })),
	};
}

async function query(env: Env, sql: string): Promise<Record<string, unknown>[]> {
	if (!env.AE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		throw new HttpError(503, "unavailable", "transaction statistics are not set up: the AE_API_TOKEN secret is missing");
	}
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.AE_API_TOKEN}` },
		body: sql.replace(/\s+/g, " ") + " FORMAT JSON",
	});
	const text = await res.text();
	if (!res.ok) {
		// A dataset nobody has written to yet does not exist.
		if (/unknown table|does not exist/i.test(text)) return [];
		console.error("analytics engine:", res.status, text.slice(0, 500));
		throw new HttpError(502, "unavailable", `analytics engine answered ${res.status}`);
	}
	return (JSON.parse(text) as { data?: Record<string, unknown>[] }).data ?? [];
}

const num = (v: unknown) => Number(v) || 0;

// isoTime turns the SQL API's "2006-01-02 15:04:05" (UTC) into RFC 3339.
function isoTime(s: string): string {
	const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
	return isNaN(d.getTime()) ? s : d.toISOString();
}
