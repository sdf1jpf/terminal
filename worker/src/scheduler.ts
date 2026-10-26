// The job scheduler. Each schedule names a job in the job library and a
// cron expression in UTC. The Worker's cron trigger fires every minute and
// runSchedules submits each enabled job that is due, as SCHEDULR. The
// minute a schedule last ran for is claimed before the job is submitted,
// so a trigger that fires twice for a minute submits it once.

import { syncIndex } from "./ai";
import { CronError, matches, nextRun, normalize, parseCron } from "./cron";
import { HttpError } from "./http";
import type { Env } from "./index";
import { jobLibrary, submitJob, type Job } from "./jobs";
import { deliverSignals } from "./lifecycle";
import { logStmt, prune, syslog } from "./syslog";
import { pollTracking } from "./tracking";

export const SCHEDULER = "SCHEDULR";

export interface Schedule {
	name: string;
	cron: string;
	enabled: number; // 1 active, 0 held
	last_due: string;
	last_job: string;
	updated: string;
	updated_by: string;
	next_run?: string; // when it runs next, if it is active
}

export async function listSchedules(db: D1Database, now = new Date()): Promise<Schedule[]> {
	const { results } = await db.prepare("SELECT * FROM schedules ORDER BY name").all<Schedule>();
	for (const s of results) {
		if (!s.enabled) continue;
		try {
			s.next_run = nextRun(parseCron(s.cron), now)?.toISOString();
		} catch {
			// a bad expression stored by hand never runs
		}
	}
	return results;
}

function checkName(name: string): string {
	name = name.trim().toUpperCase();
	if (!jobLibrary[name]) throw new HttpError(422, "invalid", `job ${name || "(blank)"} is not in the job library`, "job");
	return name;
}

function checkCron(cron: string): string {
	try {
		parseCron(cron);
	} catch (e) {
		if (e instanceof CronError) throw new HttpError(422, "invalid", `cron ${e.message}`, "cron");
		throw e;
	}
	return normalize(cron);
}

// putSchedule adds a schedule or changes its cron; a new one is active.
export async function putSchedule(db: D1Database, user: string, name: string, cron: string, enabled?: boolean): Promise<Schedule> {
	name = checkName(name);
	cron = checkCron(cron);
	const on = enabled === undefined ? null : enabled ? 1 : 0;
	const [row] = await db.batch<Schedule>([
		db.prepare(
			`INSERT INTO schedules (name, cron, enabled, updated, updated_by) VALUES (?1, ?2, COALESCE(?3, 1), ?4, ?5)
			 ON CONFLICT (name) DO UPDATE SET cron = ?2, enabled = COALESCE(?3, enabled), updated = ?4, updated_by = ?5
			 RETURNING *`,
		).bind(name, cron, on, new Date().toISOString(), user),
		logStmt(db, user, `CUS0702I SCHEDULE ${name} SET TO ${cron}${on === 0 ? " (HELD)" : ""}`),
	]);
	return (await listSchedules(db)).find((s) => s.name === row.results[0].name)!;
}

// holdSchedule holds (enabled false) or releases a schedule.
export async function holdSchedule(db: D1Database, user: string, name: string, enabled: boolean): Promise<void> {
	name = name.toUpperCase();
	const [res] = await db.batch([
		db.prepare("UPDATE schedules SET enabled = ?, updated = ?, updated_by = ? WHERE name = ?")
			.bind(enabled ? 1 : 0, new Date().toISOString(), user, name),
		logStmt(db, user, `CUS0703I SCHEDULE ${name} ${enabled ? "RELEASED" : "HELD"}`),
	]);
	if (res.meta.changes === 0) throw notScheduled(name);
}

export async function deleteSchedule(db: D1Database, user: string, name: string): Promise<void> {
	name = name.toUpperCase();
	const [res] = await db.batch([
		db.prepare("DELETE FROM schedules WHERE name = ?").bind(name),
		logStmt(db, user, `CUS0704I SCHEDULE ${name} DELETED`),
	]);
	if (res.meta.changes === 0) throw notScheduled(name);
}

function notScheduled(name: string): HttpError {
	return new HttpError(404, "not_found", `job ${name} is not scheduled`);
}

// runSchedules submits the jobs due in the minute that contains at, and
// returns them.
export async function runSchedules(env: Env, at: Date): Promise<Job[]> {
	const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
	const due = minute.toISOString();
	const { results } = await env.DB.prepare("SELECT * FROM schedules WHERE enabled = 1 AND last_due < ? ORDER BY name")
		.bind(due).all<Schedule>();
	const submitted: Job[] = [];
	for (const s of results) {
		try {
			if (!matches(parseCron(s.cron), minute)) continue;
			const claimed = await env.DB.prepare("UPDATE schedules SET last_due = ? WHERE name = ? AND last_due < ?")
				.bind(due, s.name, due).run();
			if (claimed.meta.changes === 0) continue; // another trigger has it
			const job = await submitJob(env.DB, env.JOBS, SCHEDULER, s.name);
			await env.DB.batch([
				env.DB.prepare("UPDATE schedules SET last_job = ? WHERE name = ?").bind(job.id, s.name),
				logStmt(env.DB, SCHEDULER, `CUS0701I ${s.name} RELEASED BY SCHEDULE ${s.cron} - ${job.id}`),
			]);
			submitted.push(job);
		} catch (e) {
			console.error(`scheduling ${s.name}:`, e);
			const why = e instanceof Error ? e.message : String(e);
			await syslog(env.DB, SCHEDULER, `CUS0709E ${s.name} NOT SUBMITTED: ${why}`.toUpperCase().slice(0, 200));
		}
	}
	return submitted;
}

// tick is the cron trigger's handler: it runs the schedules, passes the
// minute's order changes to their lifecycles, asks the carriers about the
// shipments on their way, keeps the HELP facility's index current and, once
// an hour, trims the log.
export async function tick(env: Env, at: Date): Promise<void> {
	await runSchedules(env, at);
	try {
		await deliverSignals(env);
	} catch (e) {
		console.error("delivering order signals:", e);
	}
	try {
		await pollTracking(env.DB, env.TABLES, at.getTime());
	} catch (e) {
		console.error("tracking shipments:", e);
	}
	try {
		if (await syncIndex(env)) await syslog(env.DB, SCHEDULER, "CUS1210I HELP FACILITY INDEX UPDATED");
	} catch (e) {
		console.error("updating the help index:", e);
	}
	if (at.getUTCMinutes() === 0) await prune(env.DB);
}
