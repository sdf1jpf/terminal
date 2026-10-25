// Batch jobs, in the style of JES on a mainframe. Submitting a job records
// it as QUEUED and sends it to the customer-jobs queue (the input queue).
// The queue consumer starts a JobRunner workflow per job; each job step is
// a durable workflow step with retries. The runner marks the job EXECUTING,
// runs the steps, and writes the output listing and the highest condition
// code, leaving the job in OUTPUT.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Customer } from "./customer";
import { partnersOrder, partnersPay, processInterchange } from "./edi";
import { HttpError } from "./http";
import type { Env } from "./index";
import { reorder, vendorsConfirm, vendorsShip } from "./purchasing";
import { logStmt } from "./syslog";
import { pickTickets } from "./shipping";

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
	steps: { name: string; run: (db: D1Database, job: Job) => Promise<StepResult> }[];
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
		steps: [{ name: "STEP010", run: statements }],
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

// getJob returns a job and its output listing, or undefined.
export async function getJob(db: D1Database, id: string): Promise<{ job: Job; output: string[] } | undefined> {
	const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Job>();
	if (!job) return undefined;
	const { results } = await db.prepare("SELECT text FROM job_output WHERE job_id = ? ORDER BY line")
		.bind(id).all<{ text: string }>();
	return { job, output: results.map((r) => r.text) };
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
					() => s.run(db, job),
				);
				results.push({ name: s.name, result });
			} catch (e) {
				results.push({ name: s.name, error: e instanceof Error ? e.message : String(e) });
				break; // an abend ends the job
			}
		}

		return step.do("output", async () => {
			const { rc, lines } = listing(job, def, results);
			const stmts = [db.prepare("DELETE FROM job_output WHERE job_id = ?").bind(job.id)];
			lines.forEach((text, i) =>
				stmts.push(db.prepare("INSERT INTO job_output (job_id, line, text) VALUES (?, ?, ?)").bind(job.id, i + 1, text)),
			);
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

// agedBalances ages each balance by its unpaid invoices: payments are
// applied to the oldest invoices first, so the balance is made up of the
// newest invoices. Any balance older than the posted activity (such as an
// opening balance) counts as over 90 days.
export async function agedBalances(db: D1Database): Promise<StepResult> {
	const { results: custs } = await db.prepare(
		"SELECT id, name, balance FROM customers WHERE balance > 0 ORDER BY id",
	).all<Pick<Customer, "id" | "name" | "balance">>();
	const { results: invoices } = await db.prepare(
		"SELECT customer_id, amount, posted FROM transactions WHERE type = 'I' ORDER BY customer_id, seq DESC",
	).all<{ customer_id: string; amount: number; posted: string }>();
	const byCust = new Map<string, { amount: number; posted: string }[]>();
	for (const inv of invoices) {
		const list = byCust.get(inv.customer_id) ?? [];
		list.push(inv);
		byCust.set(inv.customer_id, list);
	}

	const now = Date.now();
	const totals = [0, 0, 0, 0];
	const lines = [
		"",
		"CUST NO NAME                    CURRENT     31-60     61-90   OVER 90      TOTAL",
		"------- -------------------- --------- --------- --------- --------- ----------",
	];
	for (const c of custs) {
		const buckets = [0, 0, 0, 0];
		let left = c.balance;
		for (const inv of byCust.get(c.id) ?? []) {
			if (left <= 0) break;
			const amt = Math.min(inv.amount, left);
			const days = (now - Date.parse(inv.posted)) / 86_400_000;
			buckets[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3] += amt;
			left -= amt;
		}
		buckets[3] += left;
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
// with its activity from the last 30 days.
export async function statements(db: D1Database): Promise<StepResult> {
	const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
	const { results: custs } = await db.prepare(
		"SELECT * FROM customers WHERE status <> 'C' AND balance <> 0 ORDER BY id",
	).all<Customer>();
	const { results: txns } = await db.prepare(
		"SELECT customer_id, type, amount, reference, balance, posted FROM transactions WHERE posted >= ? ORDER BY seq",
	).bind(since).all<{ customer_id: string; type: string; amount: number; reference: string; balance: number; posted: string }>();

	const lines: string[] = [];
	for (const c of custs) {
		lines.push(
			"",
			`STATEMENT  ${c.id}  ${c.name}`,
			`           ${c.address}`,
			`           ${c.city}, ${c.state} ${c.zip}`,
			"",
		);
		const mine = txns.filter((t) => t.customer_id === c.id);
		for (const t of mine) {
			const amt = t.type === "I" ? dollars(t.amount) : dollars(-t.amount);
			lines.push(
				`  ${t.posted.slice(0, 10)}  ${t.type === "I" ? "INVOICE" : "PAYMENT"}  ${pad(t.reference, 12)} ${pad(amt, 12, true)}  ${pad(dollars(t.balance), 12, true)}`,
			);
		}
		if (mine.length === 0) lines.push("  NO ACTIVITY IN THE LAST 30 DAYS");
		lines.push(`  ${pad("BALANCE DUE", 42)}${pad(dollars(c.balance), 12, true)}`);
	}
	lines.push("", `${custs.length} STATEMENTS PRINTED`);
	return { rc: 0, lines };
}
