import { newExplain } from "./ask";
import { getJob, jobLibrary, listJobs, submitJob, type Job } from "../jobs";
import { header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type JobLogState, type JobsState, type Program } from "./program";

// CUSJ01 BATCH JOBS submits jobs from the job library and lists recent
// jobs with their status, like SDSF's status display. S on a job opens
// CUSJ02 JOB OUTPUT, its output listing; E on a failed job, or PF6 on its
// output, asks the HELP facility to explain it (CUSJ03, screens/ask.ts).

// jobRows is how many jobs fit on a page: 13 on 24x80.
const jobRows = (ctx: Ctx) => ctx.rows - 11;

function jobLine(name: string, id: string, owner: string, status: string, rc: string, submitted: string, ended: string): string {
	return `${pad(name, 8)} ${pad(id, 8)} ${pad(owner, 8)} ${pad(status, 9)} ${pad(rc, 5)} ${pad(submitted, 16)}  ${pad(ended, 5)}`;
}

function statusColor(j: Job): Color {
	if (j.status !== "OUTPUT") return "yellow";
	return j.rc === "0000" ? "green" : j.rc === "ABEND" ? "red" : "turquoise";
}

function scroll(s: { top?: number; msg?: string }, aid: string, rows: number, total: number): void {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		s.top = Math.max((s.top ?? 0) - rows, 0);
	} else if ((s.top ?? 0) + rows >= total) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
	} else {
		s.top = Math.min((s.top ?? 0) + rows, total - rows);
	}
}

export const jobs: Program<JobsState> = {
	async render(ctx, j) {
		const scr = newScreen(ctx, "CUSJ01");
		header(scr, ctx, "BATCH JOBS");
		let msg = j.msg ?? "";

		label(scr, 4, 2, "SUBMIT JOB ===>");
		scr.input(4, 18, 8, "job", j.job ?? "", { bright: j.errField === "job" });
		// The job library, with short descriptions if they fit, else names.
		const library = Object.entries(jobLibrary).map(([name, d]) => `${name}=${d.short}`).join("  ");
		const names = Object.keys(jobLibrary).join(" ");
		scr.text(5, 2, (library.length <= scr.cols - 2 ? library : names).slice(0, scr.cols - 2), { color: "blue" });

		let list: Job[] = [];
		try {
			list = await listJobs(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const rows = jobRows(ctx);
		const top = Math.min(j.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, "SELECT: S=VIEW OUTPUT  E=EXPLAIN A FAILURE", { color: "blue" });
		scr.text(7, 2, "S " + jobLine("JOBNAME", "JOBID", "OWNER", "STATUS", "RC", "SUBMITTED", "ENDED"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((job, i) => {
			scr.input(9 + i, 2, 1, `sel${i}`, "", { bright: j.errSel === `sel${i}` });
			scr.text(9 + i, 4, jobLine(job.name, job.id, job.submitted_by, job.status, job.rc, stamp(ctx, job.submitted),
				job.ended ? stamp(ctx, job.ended).slice(11) : ""), { color: statusColor(job) });
		});
		if (list.length === 0) scr.text(9, 4, "NO JOBS ON THE SPOOL", { color: "yellow" });
		// The commarea is written after render, so handle sees the jobs on
		// the rows the operator was looking at.
		j.ids = list.slice(top, top + rows).map((job) => job.id);

		message(scr, msg);
		keys(scr, "ENTER=SUBMIT  PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (j.errSel) scr.cursorTo(j.errSel);
		else scr.cursorTo("job");
		return scr;
	},

	async handle(ctx, j, input) {
		j.msg = j.errField = j.errSel = undefined;
		switch (input.aid) {
			case "ENTER": {
				for (const [i, id] of (j.ids ?? []).entries()) {
					const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
					if (!code) continue;
					if (code === "E") return newExplain(ctx, j, id);
					if (code !== "S") {
						j.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						j.errSel = `sel${i}`;
						return j;
					}
					return { p: "joblog", back: j, id };
				}
				const name = (input.fields.job ?? "").trim().toUpperCase();
				if (!name) return j; // Enter alone refreshes
				try {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, name);
					j.job = "";
					j.top = 0;
					j.msg = `$HASP100 ${job.name} ON INTRDR - ${job.id} SUBMITTED`;
				} catch (e) {
					j.job = name;
					if (isCode(e, "invalid")) {
						j.errField = "job";
						j.msg = `CUS0261E ${e.message.toUpperCase()}`;
					} else {
						j.msg = fail(e);
					}
				}
				return j;
			}
			case pf(3):
			case pf(12):
				return j.back;
			case pf(5):
				j.msg = `CUS0262I JOB LIST REFRESHED`;
				return j;
			case pf(7):
			case pf(8):
				scroll(j, input.aid, jobRows(ctx), (await listJobs(ctx.db)).length);
				return j;
			case "CLEAR":
				j.job = "";
				return j;
		}
		j.msg = invalidKey(input.aid);
		return j;
	},
};

// outputRows is how many listing lines fit on a page: 18 on 24x80.
const outputRows = (ctx: Ctx) => ctx.rows - 6;

export const joblog: Program<JobLogState> = {
	async render(ctx, l) {
		const scr = newScreen(ctx, "CUSJ02");
		header(scr, ctx, "JOB OUTPUT");
		let msg = l.msg ?? "";
		let found: Awaited<ReturnType<typeof getJob>>;
		try {
			found = await getJob(ctx.db, l.id);
		} catch (e) {
			msg = fail(e);
		}
		if (!found) {
			msg ||= `CUS0263E JOB ${l.id} NOT FOUND`;
		} else {
			const { job, output } = found;
			label(scr, 3, 2, `${job.name}  ${job.id}  ${job.status}${job.rc ? "  RC=" + job.rc : ""}`);
			const rows = outputRows(ctx);
			const lines = output.length > 0 ? output : [`JOB ${job.id} HAS NOT PRODUCED OUTPUT YET - PRESS PF5 TO REFRESH`];
			const top = Math.min(l.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(3, right(scr, 58), `LINE ${lpad(top + 1, 4)} OF ${lines.length}`, { color: "white" });
			lines.slice(top, top + rows).forEach((text, i) => {
				scr.text(4 + i, 2, text.slice(0, scr.cols - 2), { color: text.startsWith("IEF450I") ? "red" : "green" });
			});
		}
		message(scr, msg);
		const failed = found && found.job.status === "OUTPUT" && found.job.rc !== "0000";
		keys(scr, `PF1=HELP  PF3=EXIT  PF5=REFRESH${failed ? "  PF6=EXPLAIN" : ""}  PF7=UP  PF8=DOWN  PF12=CANCEL`);
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, l, input) {
		l.msg = undefined;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return l.back;
			case "ENTER":
			case pf(5):
				return l;
			case pf(6):
				return newExplain(ctx, l, l.id);
			case pf(7):
			case pf(8): {
				const found = await getJob(ctx.db, l.id);
				scroll(l, input.aid, outputRows(ctx), found?.output.length ?? 0);
				return l;
			}
		}
		l.msg = invalidKey(input.aid);
		return l;
	},
};
