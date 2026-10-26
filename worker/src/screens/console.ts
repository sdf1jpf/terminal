import { HttpError } from "../http";
import { submitJob } from "../jobs";
import { deleteSchedule, holdSchedule, listSchedules, putSchedule, type Schedule } from "../scheduler";
import { extent, logStmt, page, pageBefore, tail, type LogLine } from "../syslog";
import { clock, header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type ConsoleState, type Program, type ScheduleState } from "./program";

// CUSO01 OPERATOR CONSOLE shows SYSLOG and takes operator commands, which
// are logged with their responses for every console to see. While it
// follows the end of the log it is a live screen: a terminal listening on
// GET /v1/live is told when the log moves, and one that is not redraws it
// every few seconds, so new lines appear as they are written. PF6 opens CUSO02 JOB
// SCHEDULE, the jobs the scheduler submits on their cron.

const REFRESH = 5; // seconds

// logRows is how many log lines fit: 18 on 24x80.
const logRows = (ctx: Ctx) => ctx.rows - 6;

function lineColor(l: LogLine): Color {
	if (l.type === "C") return "white";
	const id = l.text.split(" ")[0];
	if (id.endsWith("E") || l.text.includes("ABEND")) return "red";
	if (id.endsWith("W")) return "yellow";
	return l.type === "R" ? "turquoise" : "green";
}

export const opconsole: Program<ConsoleState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSO01");
		header(scr, ctx, "OPERATOR CONSOLE");
		let msg = s.msg ?? "";

		label(scr, 3, 2, "COMMAND ===>");
		scr.input(3, 15, scr.cols - 16, "cmd", s.cmd ?? "");

		const n = logRows(ctx);
		let lines: LogLine[] = [];
		let total = 0;
		try {
			const log = await extent(ctx.db);
			total = log.lines;
			if (s.top !== undefined) {
				lines = await page(ctx.db, s.top, n);
				// Scrolled to the end: follow it again.
				if (lines.length < n || (lines.at(-1)?.seq ?? 0) >= log.newest) s.top = undefined;
			}
			if (s.top === undefined) lines = await tail(ctx.db, n);
		} catch (e) {
			msg = fail(e);
		}
		s.first = lines[0]?.seq;
		s.last = lines.at(-1)?.seq;

		const following = s.top === undefined;
		const how = ctx.live ? "LIVE" : `UPDATES EVERY ${REFRESH} SECONDS`;
		scr.text(4, 2, following ? `SYSLOG - FOLLOWING, ${how}` : "SYSLOG - HELD, PF5 TO FOLLOW",
			{ color: following ? "white" : "yellow", bright: true });
		scr.text(4, right(scr, 62), `LINES ${lpad(total, 6)}`, { color: "white" });
		lines.forEach((l, i) => {
			scr.text(5 + i, 2, `${clock(ctx, l.at)} ${pad(l.source, 8)} ${l.text}`.slice(0, scr.cols - 2), { color: lineColor(l) });
		});
		if (lines.length === 0 && !msg) scr.text(5, 2, "THE LOG IS EMPTY", { color: "yellow" });
		if (following) {
			scr.refresh = REFRESH;
			scr.live = "syslog";
		}

		message(scr, msg);
		keys(scr, "ENTER=COMMAND  PF1=HELP  PF3=EXIT  PF5=FOLLOW  PF6=SCHEDULE  PF7=UP  PF8=DOWN");
		scr.cursorTo("cmd");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case "ENTER": {
				const cmd = (input.fields.cmd ?? "").trim().toUpperCase();
				s.cmd = "";
				if (!cmd) return s;
				s.top = undefined; // show the response
				return command(ctx, s, cmd);
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.top = undefined;
				s.msg = "CUS0706I FOLLOWING THE LOG";
				return s;
			case pf(6):
				return { p: "schedule", back: s };
			case pf(7): {
				const top = s.first === undefined ? undefined : await pageBefore(ctx.db, s.first, logRows(ctx));
				if (top === undefined) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
				else s.top = top;
				return s;
			}
			case pf(8):
				if (s.top === undefined || s.last === undefined) s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				else s.top = s.last + 1;
				return s;
			case "CLEAR":
				s.cmd = "";
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// command runs an operator command. The command and its responses go in
// the log; a failure also shows on the message line.
async function command(ctx: Ctx, s: ConsoleState, cmd: string): Promise<ConsoleState | ScheduleState> {
	const db = ctx.db;
	const [verb, ...args] = cmd.split(/[\s,]+/);
	const arg = args[0] ?? "";
	const out: string[] = [];
	let next: ConsoleState | ScheduleState = s;
	try {
		switch (verb) {
			case "D":
			case "DISPLAY":
				out.push(...(await display(ctx, arg)));
				break;
			case "S":
			case "START":
			case "SUBMIT":
				await submitJob(db, ctx.jobs, ctx.user, arg); // logs $HASP100
				break;
			case "H":
			case "HOLD":
			case "A":
			case "RELEASE":
				await holdSchedule(db, ctx.user, arg, verb === "A" || verb === "RELEASE"); // logs CUS0703I
				break;
			case "SCHED":
			case "SCHEDULE":
				next = { p: "schedule", back: s };
				break;
			default:
				out.push(`IEE305I ${verb} COMMAND INVALID`);
		}
	} catch (e) {
		if (!(e instanceof HttpError)) throw e;
		out.push(`CUS0705E ${e.message.toUpperCase()}`);
	}
	await db.batch([logStmt(db, ctx.user, cmd, "C"), ...out.map((t) => logStmt(db, ctx.user, t, "R"))]);
	const err = out.find((t) => /^\S+E /.test(t));
	if (err) {
		s.msg = err;
		s.cmd = cmd;
	}
	return next;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// mvsTime formats d's UTC fields as "TIME=15.04.05 DATE=2006.002", with
// the day of the year.
function mvsTime(d: Date): string {
	const ddd = String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000)).padStart(3, "0");
	return `TIME=${pad2(d.getUTCHours())}.${pad2(d.getUTCMinutes())}.${pad2(d.getUTCSeconds())} DATE=${d.getUTCFullYear()}.${ddd}`;
}

async function display(ctx: Ctx, what: string): Promise<string[]> {
	const now = new Date();
	switch (what) {
		case "T":
		case "TIME": {
			const local = new Date(now.getTime() + ctx.tzOffset * 60_000);
			return [`IEE136I LOCAL: ${mvsTime(local)}  UTC: ${mvsTime(now)}`];
		}
		case "J":
		case "A":
		case "JOBS": {
			const { results } = await ctx.db.prepare(
				"SELECT id, name, status FROM jobs WHERE status <> 'OUTPUT' ORDER BY id",
			).all<{ id: string; name: string; status: string }>();
			const n = (st: string) => results.filter((j) => j.status === st).length;
			return [
				`IEE115I ${mvsTime(now).slice(5, 13)} ACTIVITY  ${n("EXECUTING")} EXECUTING  ${n("QUEUED")} QUEUED`,
				...results.slice(0, 10).map((j) => `  ${j.id} ${pad(j.name, 8)} ${j.status}`),
			];
		}
		case "SCHED":
		case "SCHEDULE": {
			const list = await listSchedules(ctx.db, now);
			return [
				`CUS0707I ${list.length} SCHEDULED JOBS, TIMES UTC`,
				...list.map((sc) => `  ${pad(sc.name, 8)} ${pad(sc.cron, 16)} ${sc.enabled ? "ACTIVE" : "HELD  "}` +
					(sc.next_run ? `  NEXT ${sc.next_run.slice(0, 16).replace("T", " ")}` : "")),
			];
		}
		case "TS":
		case "U":
		case "USERS": {
			const users = await ctx.tso.users();
			return [
				`IEE114I ${mvsTime(now).slice(5, 13)} ${users.length} TSO USERS, * IS THIS ONE`,
				...users.slice(0, 15).map((u) => `  ${pad(u.user, 8)} ${u.sid} ${pad(u.terminal, 8)} ${pad(u.map, 8)}` +
					` IDLE ${idle(now, u.seen)}${u.sid === ctx.sid ? " *" : ""}`),
			];
		}
		case "GRS":
		case "LOCKS": {
			const locks = await ctx.tso.locks();
			if (locks.length === 0) return ["ISG343I GRS STATUS - NO RECORDS ARE LOCKED"];
			return [
				`ISG343I GRS STATUS - ${locks.length} RECORD${locks.length === 1 ? "" : "S"} LOCKED FOR UPDATE`,
				...locks.slice(0, 15).map((l) => `  ${pad(l.resource, 18)} ${pad(l.user, 8)} ${pad(l.terminal, 8)} ${clock(ctx, l.since).slice(6)}`),
			];
		}
	}
	return [`IEE305I D ${what || "(BLANK)"} COMMAND INVALID - USE D T, D J, D SCHED, D TS OR D GRS`];
}

// idle says how long ago seen was, as MM:SS, or HH:MM:SS past an hour.
function idle(now: Date, seen: string): string {
	const s = Math.max(Math.floor((now.getTime() - Date.parse(seen)) / 1000), 0);
	const mmss = `${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
	return s >= 3600 ? `${pad2(Math.floor(s / 3600))}:${mmss}` : mmss;
}

// --- CUSO02 JOB SCHEDULE ---------------------------------------------------

// schedRows is how many schedules fit on a page: 13 on 24x80.
const schedRows = (ctx: Ctx) => ctx.rows - 11;

function schedLine(name: string, cron: string, status: string, next: string, last: string, job: string): string {
	return `${pad(name, 8)} ${pad(cron, 16)} ${pad(status, 6)} ${pad(next, 16)} ${pad(last, 16)} ${pad(job, 8)}`;
}

export const schedule: Program<ScheduleState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSO02");
		header(scr, ctx, "JOB SCHEDULE");
		let msg = s.msg ?? "";
		const vals = s.vals ?? {};

		label(scr, 4, 2, "JOB ===>");
		scr.input(4, 11, 8, "job", vals.job ?? "", { bright: s.errField === "job" });
		label(scr, 4, 21, "CRON (UTC) ===>");
		scr.input(4, 37, 20, "cron", vals.cron ?? "", { bright: s.errField === "cron" });
		scr.text(4, 59, "ENTER=ADD/CHANGE", { color: "blue" });
		scr.text(5, 2, "CRON IS MINUTE HOUR DAY MONTH WEEKDAY: 0 6 * * * IS 06:00 UTC DAILY", { color: "blue" });

		let list: Schedule[] = [];
		try {
			list = await listSchedules(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const rows = schedRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(6, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, "SELECT: H=HOLD  R=RELEASE  S=SUBMIT NOW  D=DELETE", { color: "blue" });
		scr.text(7, 2, "S " + schedLine("JOBNAME", "CRON (UTC)", "STATUS", "NEXT RUN", "LAST RUN", "LAST JOB"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((sc, i) => {
			scr.input(9 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(9 + i, 4, schedLine(sc.name, sc.cron, sc.enabled ? "ACTIVE" : "HELD", sc.next_run ? stamp(ctx, sc.next_run) : "",
				sc.last_due ? stamp(ctx, sc.last_due) : "", sc.last_job), { color: sc.enabled ? "green" : "yellow" });
		});
		if (list.length === 0) scr.text(9, 4, "NO JOBS ARE SCHEDULED", { color: "yellow" });
		s.names = list.slice(top, top + rows).map((sc) => sc.name);

		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel) scr.cursorTo(s.errSel);
		else if (s.errField) scr.cursorTo(s.errField);
		else scr.cursorTo("job");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER":
				return process(ctx, s, input.fields);
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.msg = "CUS0708I SCHEDULE REFRESHED";
				return s;
			case pf(7):
				if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
				s.top = Math.max((s.top ?? 0) - schedRows(ctx), 0);
				return s;
			case pf(8): {
				const total = (await listSchedules(ctx.db)).length;
				if ((s.top ?? 0) + schedRows(ctx) >= total) s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				else s.top = (s.top ?? 0) + schedRows(ctx);
				return s;
			}
			case "CLEAR":
				s.vals = undefined;
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

async function process(ctx: Ctx, s: ScheduleState, fields: Record<string, string>): Promise<ScheduleState> {
	for (const [i, name] of (s.names ?? []).entries()) {
		const code = (fields[`sel${i}`] ?? "").trim().toUpperCase();
		if (!code) continue;
		try {
			switch (code) {
				case "H":
				case "R":
					await holdSchedule(ctx.db, ctx.user, name, code === "R");
					s.msg = `CUS0703I SCHEDULE ${name} ${code === "R" ? "RELEASED" : "HELD"}`;
					return s;
				case "S": {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, name);
					s.msg = `$HASP100 ${job.name} ON INTRDR - ${job.id} SUBMITTED`;
					return s;
				}
				case "D":
					await deleteSchedule(ctx.db, ctx.user, name);
					s.msg = `CUS0704I SCHEDULE ${name} DELETED`;
					return s;
			}
		} catch (e) {
			s.msg = fail(e);
			return s;
		}
		s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
		s.errSel = `sel${i}`;
		return s;
	}

	const job = (fields.job ?? "").trim().toUpperCase();
	const cron = (fields.cron ?? "").trim().toUpperCase();
	if (!job && !cron) {
		s.vals = undefined;
		return s; // Enter alone refreshes
	}
	s.vals = { job, cron };
	try {
		const sc = await putSchedule(ctx.db, ctx.user, job, cron);
		s.vals = undefined;
		s.msg = `CUS0702I SCHEDULE ${sc.name} SET TO ${sc.cron}` + (sc.next_run ? `, NEXT RUN ${stamp(ctx, sc.next_run)}` : "");
	} catch (e) {
		if (!isCode(e, "invalid")) {
			s.msg = fail(e);
			return s;
		}
		s.errField = e.field ?? "job";
		s.msg = `CUS0709E ${e.message.toUpperCase()}`;
	}
	return s;
}

