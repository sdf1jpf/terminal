// Batch jobs, in the style of JES on a mainframe. Submitting a job records
// it as QUEUED and sends it to the customer-jobs queue (the input queue).
// The queue consumer starts a JobRunner workflow per job; each job step is
// a durable workflow step with retries. The runner marks the job EXECUTING,
// runs the steps, and writes the output listing to the spool and the
// highest condition code, leaving the job in OUTPUT.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Customer } from "./customer";
import { partnersOrder, partnersPay, processInterchange } from "./edi";
import { HttpError } from "./http";
import type { Env } from "./index";
import { reorder, vendorsConfirm, vendorsShip } from "./purchasing";
import { outputLines, spoolStmts } from "./spool";
import { logStmt } from "./syslog";
import { agedAccounts } from "./reports";
import { pickTickets } from "./shipping";
import { manifestStep, planStep } from "./fleet";
import { closeStep, dunningLetters, journalStep, lastClosed, trialBalance, trialBalanceReport, trialBalanceStep } from "./ledger";
import { archiveSpool, putArchive, RETENTION_DAYS } from "./archive";
import { mailStep } from "./mail";
import { buildStatements, listingPdf, statementLines, statementPdf } from "./documents";
import { commissionMonth, commissionStatement, listSalespeople } from "./sales";

export interface Job {
	id: string;
	name: string;
	status: "QUEUED" | "EXECUTING" | "OUTPUT";
	rc: string;
	submitted: string;
	submitted_by: string;
	started: string;
	ended: string;
}

// A message on the customer-jobs queue: a job to run, or (kind "edi") an
// inbound EDI interchange to process.
export interface JobMessage {
	id: string;
	kind?: "edi";
}

// StepResult is what one job step leaves behind: a condition code and the
// lines it printed.
export interface StepResult {
	rc: number;
	lines: string[];
}

interface JobDef {
	title: string;
	short: string; // for the submit panel's job list
	steps: { name: string; run: (db: D1Database, job: Job, env: Env) => Promise<StepResult> }[];
}

// The job library. Names are eight characters, as on the real thing.
export const jobLibrary: Record<string, JobDef> = {
	CUSAGING: {
		title: "AGED BALANCES REPORT",
		short: "AGING",
		steps: [{ name: "STEP010", run: agedBalances }],
	},
	CUSCRREV: {
		title: "CREDIT REVIEW - HOLD ACCOUNTS OVER LIMIT",
		short: "CREDIT REVIEW",
		steps: [
			{ name: "STEP010", run: creditWatchList },
			{ name: "STEP020", run: holdOverLimit },
		],
	},
	CUSSTMT: {
		title: "CUSTOMER STATEMENTS",
		short: "STATEMENTS",
		steps: [
			{ name: "STEP010", run: statements },
			{ name: "STEP020", run: mailStep("S") },
		],
	},
	EDISIM: {
		title: "EDI TRADING PARTNER SIMULATOR",
		short: "EDI SIM",
		steps: [
			{ name: "STEP010", run: partnersOrder },
			{ name: "STEP020", run: partnersPay },
		],
	},
	CUSREORD: {
		title: "REORDER LOW STOCK FROM VENDORS",
		short: "REORDER",
		steps: [{ name: "STEP010", run: reorder }],
	},
	CUSPICK: {
		title: "PICK TICKETS FOR THE WAREHOUSE",
		short: "PICK TICKETS",
		steps: [{ name: "STEP010", run: pickTickets }],
	},
	CUSLOAD: {
		title: "PLAN TODAY'S TRUCK LOADS, PRINT MANIFESTS",
		short: "TRUCK LOADS",
		steps: [
			{ name: "STEP010", run: planStep },
			{ name: "STEP020", run: manifestStep },
		],
	},
	CUSCLOSE: {
		title: "MONTH-END CLOSE",
		short: "MONTH END",
		steps: [
			{ name: "STEP010", run: journalStep },
			{ name: "STEP020", run: trialBalanceStep },
			{ name: "STEP030", run: closeStep },
			{ name: "STEP040", run: monthEndArchive },
		],
	},
	CUSTRIAL: {
		title: "TRIAL BALANCE",
		short: "TRIAL BAL",
		steps: [
			{ name: "STEP010", run: journalStep },
			{ name: "STEP020", run: trialBalanceStep },
		],
	},
	CUSDUNN: {
		title: "DUNNING LETTERS FOR OVERDUE INVOICES",
		short: "DUNNING",
		steps: [
			{ name: "STEP010", run: (db, job, env) => dunningLetters(db, job, env.ARCHIVE) },
			{ name: "STEP020", run: mailStep("D") },
		],
	},
	CUSCOMM: {
		title: "SALESPEOPLE'S COMMISSION STATEMENTS",
		short: "COMMISSIONS",
		steps: [
			{ name: "STEP010", run: commissionStatements },
			{ name: "STEP020", run: mailStep("M") },
		],
	},
	CUSARCH: {
		title: "ARCHIVE OLD SPOOL OUTPUT TO R2",
		short: "ARCHIVE",
		steps: [{ name: "STEP010", run: archiveOutput }],
	},
	VENDSIM: {
		title: "EDI VENDOR SIMULATOR",
		short: "VENDOR SIM",
		steps: [
			{ name: "STEP010", run: vendorsConfirm },
			{ name: "STEP020", run: vendorsShip },
		],
	},
};

// submitJob records a job and puts it on the input queue.
export async function submitJob(db: D1Database, queue: Queue<JobMessage>, user: string, name: string): Promise<Job> {
	name = name.trim().toUpperCase();
	if (!jobLibrary[name]) {
		throw new HttpError(422, "invalid", `job ${name || "(blank)"} is not in the job library`, "job");
	}
	const [, inserted] = await db.batch<Job>([
		db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'job_id'"),
		db.prepare(
			`INSERT INTO jobs (id, name, status, submitted, submitted_by)
			 SELECT printf('JOB%05d', value), ?, 'QUEUED', ?, ? FROM counters WHERE name = 'job_id'
			 RETURNING *`,
		).bind(name, new Date().toISOString(), user),
	]);
	const job = inserted.results[0];
	try {
		await queue.send({ id: job.id } satisfies JobMessage);
	} catch (e) {
		await db.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
		throw e;
	}
	await logStmt(db, job.id, `$HASP100 ${job.name} ON INTRDR FROM ${user}`).run();
	return job;
}

// listJobs returns the most recent jobs, newest first.
export async function listJobs(db: D1Database): Promise<Job[]> {
	const { results } = await db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all<Job>();
	return results;
}

// getJob returns a job and its output listing, which is on the spool, or
// undefined.
export async function getJob(db: D1Database, id: string): Promise<{ job: Job; output: string[] } | undefined> {
	const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
	if (!job) return undefined;
	return { job, output: (await outputLines(db, id)) ?? [] };
}

// startJobs is the queue consumer: it starts a JobRunner for each job,
// named after the job, and processes each EDI interchange. A redelivered
// message finds its workflow already there, or its interchange already
// processed, and is acked.
export async function startJobs(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
	for (const msg of batch.messages) {
		const { id, kind } = msg.body;
		if (kind === "edi") {
			try {
				await processInterchange(env.DB, id);
				msg.ack();
			} catch (e) {
				console.error(`processing ${id}:`, e);
				msg.retry();
			}
			continue;
		}
		try {
			await env.JOB_RUNNER.create({ id, params: { id } });
			msg.ack();
		} catch (e) {
			const started = await env.JOB_RUNNER.get(id).then(() => true, () => false);
			if (started) {
				msg.ack();
				continue;
			}
			console.error(`starting ${id}:`, e);
			msg.retry();
		}
	}
}

// JobRunner runs one job as a workflow.
export class JobRunner extends WorkflowEntrypoint<Env, JobMessage> {
	async run(event: Readonly<WorkflowEvent<JobMessage>>, step: WorkflowStep): Promise<string> {
		const db = this.env.DB;
		const job = await step.do("start", async () => {
			const [updated] = await db.batch<Job>([
				db.prepare("UPDATE jobs SET status = 'EXECUTING', started = ? WHERE id = ? RETURNING *")
					.bind(new Date().toISOString(), event.payload.id),
				db.prepare(
					`INSERT INTO syslog (at, source, type, text)
					 SELECT ?, id, 'M', '$HASP373 ' || name || ' STARTED' FROM jobs WHERE id = ?`,
				).bind(new Date().toISOString(), event.payload.id),
			]);
			const row = updated.results[0];
			if (!row) throw new Error(`no job ${event.payload.id}`);
			return row;
		});
		const def = jobLibrary[job.name];

		const results: { name: string; result?: StepResult; error?: string }[] = [];
		for (const s of def.steps) {
			try {
				const result = await step.do(
					s.name,
					{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
					() => s.run(db, job, this.env),
				);
				results.push({ name: s.name, result });
			} catch (e) {
				results.push({ name: s.name, error: e instanceof Error ? e.message : String(e) });
				break; // an abend ends the job
			}
		}

		return step.do("output", async () => {
			const { rc, lines } = listing(job, def, results);
			// The output is held on the spool (spool.ts).
			const stmts = spoolStmts(db, { id: job.id, name: job.name, owner: job.submitted_by, title: def.title }, lines);
			stmts.push(
				db.prepare("UPDATE jobs SET status = 'OUTPUT', rc = ?, ended = ? WHERE id = ?")
					.bind(rc, new Date().toISOString(), job.id),
				...lines.filter((l) => l.startsWith("IEF450I")).map((l) => logStmt(db, job.id, l)),
				logStmt(db, job.id, `$HASP395 ${job.name} ENDED - RC=${rc}`),
			);
			await db.batch(stmts);
			return rc;
		});
	}
}

// listing builds the job's output: a JES-style job log, then each step's
// lines and the messages for its condition code.
export function listing(
	job: Job,
	def: JobDef,
	results: { name: string; result?: StepResult; error?: string }[],
): { rc: string; lines: string[] } {
	const at = (iso: string) => iso.slice(11, 19);
	const lines = [
		`                 J E S 2   J O B   L O G  --  ${job.id}  ${job.name}`,
		"",
		`${at(job.started)} ${job.id}  $HASP373 ${job.name} STARTED - ${def.title}`,
		`${at(job.started)} ${job.id}  SUBMITTED BY ${job.submitted_by} AT ${job.submitted.slice(0, 19).replace("T", " ")}`,
	];
	let max = 0;
	let abend = false;
	for (const r of results) {
		lines.push("", `-- ${job.name}.${r.name} ${"-".repeat(56)}`);
		if (r.error !== undefined) {
			abend = true;
			lines.push(`IEF450I ${job.name} ${r.name} - ABEND=U0100`, `  ${r.error.toUpperCase()}`);
			continue;
		}
		const res = r.result!;
		lines.push(...res.lines);
		max = Math.max(max, res.rc);
		lines.push(`IEF142I ${job.name} ${r.name} - STEP WAS EXECUTED - COND CODE ${cc(res.rc)}`);
	}
	const rc = abend ? "ABEND" : cc(max);
	lines.push("", `$HASP395 ${job.name} ENDED - RC=${rc}`);
	return { rc, lines };
}

function cc(n: number): string {
	return String(n).padStart(4, "0");
}

export function dollars(n: number): string {
	const s = "$" + Math.abs(n).toLocaleString("en-US");
	return n < 0 ? "-" + s : s;
}

function pad(s: string | number, n: number, left = false): string {
	const v = String(s).slice(0, n);
	return left ? v.padStart(n) : v.padEnd(n);
}

// agedBalances prints the aging of each balance (see agedAccounts).
export async function agedBalances(db: D1Database): Promise<StepResult> {
	const custs = await agedAccounts(db);
	const totals = [0, 0, 0, 0];
	const lines = [
		"",
		"CUST NO NAME                    CURRENT     31-60     61-90   OVER 90      TOTAL",
		"------- -------------------- --------- --------- --------- --------- ----------",
	];
	for (const { buckets, ...c } of custs) {
		buckets.forEach((b, i) => (totals[i] += b));
		lines.push(
			`${pad(c.id, 7)} ${pad(c.name, 20)} ` + buckets.map((b) => pad(b ? dollars(b) : "", 9, true)).join(" ") +
				" " + pad(dollars(c.balance), 10, true),
		);
	}
	const total = totals.reduce((a, b) => a + b, 0);
	lines.push(
		"------- -------------------- --------- --------- --------- --------- ----------",
		`${pad("TOTALS", 28)} ` + totals.map((b) => pad(dollars(b), 9, true)).join(" ") + " " + pad(dollars(total), 10, true),
		"",
		`${custs.length} ACCOUNTS WITH A BALANCE`,
	);
	// Anything over 90 days is worth a warning.
	return { rc: totals[3] > 0 ? 4 : 0, lines };
}

// creditWatchList lists active accounts at 90% or more of their limit.
export async function creditWatchList(db: D1Database): Promise<StepResult> {
	const { results } = await db.prepare(
		`SELECT id, name, balance, credit_limit FROM customers
		 WHERE status = 'A' AND credit_limit > 0 AND balance * 10 >= credit_limit * 9 ORDER BY id`,
	).all<Pick<Customer, "id" | "name" | "balance" | "credit_limit">>();
	const lines = ["", "ACTIVE ACCOUNTS AT 90% OF THEIR LIMIT OR MORE:"];
	for (const c of results) {
		lines.push(
			`  ${c.id} ${pad(c.name, 24)} BALANCE ${pad(dollars(c.balance), 11, true)}  LIMIT ${pad(dollars(c.credit_limit), 11, true)}` +
				`  ${Math.floor((c.balance * 100) / c.credit_limit)}%`,
		);
	}
	if (results.length === 0) lines.push("  NONE");
	return { rc: 0, lines };
}

// holdOverLimit puts active accounts whose balance is over their limit on
// hold, recording each change in the history as made by the job.
export async function holdOverLimit(db: D1Database, job: Job): Promise<StepResult> {
	const { results } = await db.prepare(
		"SELECT id, name, balance, credit_limit FROM customers WHERE status = 'A' AND balance > credit_limit ORDER BY id",
	).all<Pick<Customer, "id" | "name" | "balance" | "credit_limit">>();
	const lines = ["", "ACCOUNTS OVER THEIR LIMIT, PLACED ON HOLD:"];
	const ts = new Date().toISOString();
	const over = "id = ? AND status = 'A' AND balance > credit_limit";
	for (const c of results) {
		// Same condition on both, in one batch: a re-run after a retry holds
		// and records each account once.
		const [, held] = await db.batch([
			db.prepare(
				`INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by)
				 SELECT id, 'CHANGE', 'STATUS', 'A', 'H', ?, ? FROM customers WHERE ${over}`,
			).bind(ts, job.name, c.id),
			db.prepare(
				`UPDATE customers SET status = 'H', version = version + 1, updated = ?, updated_by = ? WHERE ${over}`,
			).bind(ts, job.name, c.id),
		]);
		if (held.meta.changes === 0) continue;
		lines.push(
			`  ${c.id} ${pad(c.name, 24)} BALANCE ${pad(dollars(c.balance), 11, true)}  LIMIT ${pad(dollars(c.credit_limit), 11, true)}`,
		);
	}
	const n = lines.length - 2;
	if (n === 0) lines.push("  NONE");
	lines.push("", `${n} ACCOUNTS PLACED ON HOLD`);
	return { rc: n > 0 ? 4 : 0, lines };
}

// statements prints a statement for each open account with a balance,
// with its activity from the last 30 days, and files a PDF of each in the
// archive.
export async function statements(db: D1Database, job: Job, env: Env): Promise<StepResult> {
	const list = await buildStatements(db);
	const lines: string[] = [];
	for (const st of list) {
		const mine = statementLines(st);
		lines.push(...mine);
		await putArchive(db, env.ARCHIVE, {
			key: `statements/${st.asOf.slice(0, 7)}/${st.customer.id}`, kind: "S", ref: st.customer.id, name: job.name,
			title: `STATEMENT ${st.customer.name}`.slice(0, 60), owner: job.submitted_by, created: st.asOf, archived_by: job.name,
		}, mine, statementPdf(st));
	}
	lines.push("", `${list.length} STATEMENTS PRINTED, ${list.length} FILED IN THE ARCHIVE`);
	return { rc: 0, lines };
}

// commissionStatements is CUSCOMM's first step: a commission statement for
// each active salesperson for the month (sales.ts commissionMonth), filed
// in the archive under commissions/<month>/<salesperson>, with -<day> for
// a month-to-date run. The next step mails them.
export async function commissionStatements(db: D1Database, job: Job, env: Env): Promise<StepResult> {
	const now = new Date();
	const month = commissionMonth(now);
	// A run during the month prints the month so far; each is filed (and
	// mailed) on its own, apart from the final one for the month.
	const final = month !== now.toISOString().slice(0, 7);
	const lines: string[] = [];
	let total = 0;
	let n = 0;
	for (const sp of await listSalespeople(db)) {
		if (sp.status !== "A") continue;
		const st = await commissionStatement(db, sp, month);
		lines.push(...st.lines, "", "");
		total += st.commission;
		n++;
		const title = `COMMISSION STATEMENT ${month}${final ? "" : " TO DATE"} ${sp.name}`.slice(0, 60);
		await putArchive(db, env.ARCHIVE, {
			key: `commissions/${month}/${sp.id}${final ? "" : `-${now.toISOString().slice(8, 10)}`}`, kind: "M", ref: sp.id, name: job.name, title, owner: job.submitted_by,
			created: new Date().toISOString(), archived_by: job.name,
		}, st.lines, listingPdf({ id: sp.id, name: job.name, title }, st.lines));
	}
	lines.push(`${n} COMMISSION STATEMENTS FOR ${month}${final ? "" : " TO DATE"}, ${dollars(total)} IN COMMISSION, FILED IN THE ARCHIVE`);
	return { rc: 0, lines };
}

// archiveOutput is CUSARCH's step: output more than a week old moves off
// the spool into the archive.
export async function archiveOutput(db: D1Database, job: Job, env: Env): Promise<StepResult> {
	const done = await archiveSpool(db, env.ARCHIVE, job.name);
	const lines = ["", `OUTPUT ON THE SPOOL MORE THAN ${RETENTION_DAYS} DAYS, MOVED TO THE ARCHIVE:`, ""];
	for (const e of done) lines.push(`  ${pad(e.name, 8)} ${pad(e.ref, 8)} ${pad(e.lines, 6, true)} LINES  ${e.created.slice(0, 10)}  ${e.key}`);
	if (done.length === 0) lines.push("  NONE");
	lines.push("", `${done.length} OUTPUT GROUPS ARCHIVED`);
	return { rc: 0, lines };
}

// monthEndArchive is CUSCLOSE's last step: the closed period's trial
// balance and the aged balances as of the close go to the archive.
export async function monthEndArchive(db: D1Database, job: Job, env: Env): Promise<StepResult> {
	const closed = await lastClosed(db);
	if (!closed) return { rc: 4, lines: ["", "NO CLOSED PERIOD TO ARCHIVE"] };
	const p = closed.period;
	const reports = [
		{ id: "TRIALBAL", title: `TRIAL BALANCE ${p}`, lines: trialBalanceReport(await trialBalance(db, p)).lines },
		{ id: "AGING", title: `AGED BALANCES AT CLOSE OF ${p}`, lines: (await agedBalances(db)).lines },
	];
	const lines = ["", `MONTH-END REPORTS FOR ${p} FILED IN THE ARCHIVE:`, ""];
	for (const r of reports) {
		const o = { id: r.id, name: job.name, title: r.title };
		const e = await putArchive(db, env.ARCHIVE, {
			key: `month-end/${p}/${r.id}`, kind: "M", ref: p, name: job.name, title: r.title, owner: job.submitted_by,
			created: new Date().toISOString(), archived_by: job.name,
		}, r.lines, listingPdf(o, r.lines));
		lines.push(`  ${pad(r.title, 40)} ${pad(e.lines, 5, true)} LINES  ${e.key}`);
	}
	return { rc: 0, lines };
}
