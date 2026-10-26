// Accounts receivable and the general ledger, shared by the REST endpoints
// (index.ts), the screens (screens/ledger.ts) and the batch jobs (jobs.ts).
//
// The ledger is fed from the subledgers in batch, the way a month-end
// close does it. journal() posts everything not yet journaled into the
// open period, each source row once:
//
//	invoice posted (transactions I)   Dr 1200 AR          Cr 4000 SALES
//	                                                      Cr 2200 SALES TAX PAYABLE (its tax)
//	payment posted (transactions P)   Dr 1000 CASH        Cr 1200 AR
//	                                  Dr 4100 SALES DISCOUNTS (an early-payment discount taken)
//	cost of a billed invoice          Dr 5000 COGS        Cr 1300 INVENTORY
//	goods received (receipts)         Dr 1300 INVENTORY   Cr 2000 AP
//	stock adjusted by hand, a gain    Dr 1300 INVENTORY   Cr 5100 ADJUSTMENTS
//	                    ... a loss    Dr 5100 ADJUSTMENTS Cr 1300 INVENTORY
//	a carrier's charge, once shipped  Dr 5200 FREIGHT     Cr 2100 ACCRUED FREIGHT
//	a company truck load, once back   Dr 5210 TRUCK       Cr 2110 ACCRUED FLEET COSTS (fleet.ts)
//
// The first run also posts opening balances against retained earnings, for
// the customers' balances and the stock that were on file before the
// ledger began. closePeriod() closes the open period and opens the next.
//
// Dunning (dunningLetters) writes to customers about invoices billed more
// than 30 days ago (terms are net 30): a reminder, then a second notice
// after 30 days past due, then a final notice after 60, which also puts
// the account on hold.

import { putArchive } from "./archive";
import { dunningLevels, letterLines, letterPdf, type Letter } from "./documents";
import { HttpError } from "./http";
import type { StepResult } from "./jobs";

export interface Account {
	account: string;
	name: string;
	type: "A" | "L" | "Q" | "R" | "X";
}

export interface Period {
	period: string;
	status: "O" | "C";
	closed: string;
	closed_by: string;
}

export interface Entry {
	seq: number;
	period: string;
	account: string;
	debit: number;
	credit: number;
	source: string;
	reference: string;
	memo: string;
	posted: string;
	posted_by: string;
}

export interface TrialBalanceRow extends Account {
	debit: number; // the balance, on its debit or credit side
	credit: number;
	activity: number; // net debits less credits in the period itself
}

export interface TrialBalance {
	period: Period;
	rows: TrialBalanceRow[];
	debits: number;
	credits: number;
	subledger: number; // what customers owe, from their accounts
	unjournaled: number; // postings and receipts not yet in the journal
}

export const typeNames: Record<string, string> = { A: "ASSET", L: "LIABILITY", Q: "EQUITY", R: "REVENUE", X: "EXPENSE" };

const now = () => new Date().toISOString();
const DAY = 86_400_000;

function nextPeriod(p: string): string {
	const [y, m] = p.split("-").map(Number);
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// openPeriod returns the open period, opening this month's if there has
// never been one.
export async function openPeriod(db: D1Database): Promise<Period> {
	const open = await db.prepare("SELECT * FROM gl_periods WHERE status = 'O' ORDER BY period LIMIT 1").first<Period>();
	if (open) return open;
	const last = await db.prepare("SELECT period FROM gl_periods ORDER BY period DESC LIMIT 1").first<{ period: string }>();
	const period = last ? nextPeriod(last.period) : now().slice(0, 7);
	await db.prepare("INSERT OR IGNORE INTO gl_periods (period, status) VALUES (?, 'O')").bind(period).run();
	return (await db.prepare("SELECT * FROM gl_periods WHERE period = ?").bind(period).first<Period>())!;
}

export async function listPeriods(db: D1Database): Promise<Period[]> {
	const { results } = await db.prepare("SELECT * FROM gl_periods ORDER BY period DESC LIMIT 60").all<Period>();
	return results;
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
	const { results } = await db.prepare("SELECT * FROM gl_accounts ORDER BY account").all<Account>();
	return results;
}

// The cost of an invoice's lines at the products' unit costs.
const invoiceCost = `(SELECT COALESCE(SUM(l.quantity * p.unit_cost), 0) FROM invoice_lines l JOIN products p ON p.sku = l.sku
                      WHERE l.invoice_id = t.reference)`;

// The sales tax on the invoice a transaction posted.
const invoiceTax = "COALESCE((SELECT tax FROM invoices WHERE id = t.reference), 0)";

// The early-payment discount taken on the invoice a payment paid.
const discountTaken = "COALESCE((SELECT discount_taken FROM invoices WHERE id = t.reference), 0)";

// adjustMemo describes a stock adjustment: ADJUST BRG-6204 +5 or -5, and
// AT $7 when the unit cost changed.
const adjustMemo = `'ADJUST ' || sku || CASE WHEN quantity > 0 THEN ' +' || quantity WHEN quantity < 0 THEN ' ' || quantity ELSE '' END
                    || CASE WHEN new_cost <> old_cost THEN ' AT $' || new_cost ELSE '' END`;

// journal posts every source row not yet journaled into the open period,
// and the opening balances the first time. A re-run posts nothing twice.
export async function journal(db: D1Database, by: string): Promise<{ period: string; entries: number; byAccount: Map<string, { debit: number; credit: number }> }> {
	const { period } = await openPeriod(db);
	const ts = now();
	const pair = (debit: string, credit: string, amount: string, source: string, ref: string, memo: string, from: string) =>
		[debit, credit].map((account, i) => db.prepare(
			`INSERT INTO gl_entries (period, account, debit, credit, source, reference, memo, posted, posted_by)
			 SELECT ?1, '${account}', ${i === 0 ? amount : 0}, ${i === 0 ? 0 : amount}, ${source}, ${ref}, ${memo}, ?2, ?3
			 ${from}
			 ON CONFLICT (source, account) DO NOTHING`,
		).bind(period, ts, by));

	const side = (account: string, col: "debit" | "credit", amount: string, source: string, ref: string, memo: string, from: string) => [
		db.prepare(
			`INSERT INTO gl_entries (period, account, debit, credit, source, reference, memo, posted, posted_by)
			 SELECT ?1, '${account}', ${col === "debit" ? amount : 0}, ${col === "credit" ? amount : 0}, ${source}, ${ref}, ${memo}, ?2, ?3
			 ${from}
			 ON CONFLICT (source, account) DO NOTHING`,
		).bind(period, ts, by),
	];

	const stmts = [
		// An invoice's sales tax is owed to the state, not earned.
		...pair("1200", "4000", "amount", "'T:' || seq", "customer_id", "'INVOICE ' || reference", "FROM transactions t WHERE type = 'I'")
			.slice(0, 1),
		...side("4000", "credit", `amount - ${invoiceTax}`, "'T:' || seq", "customer_id", "'INVOICE ' || reference",
			`FROM transactions t WHERE type = 'I' AND amount - ${invoiceTax} <> 0`),
		...side("2200", "credit", invoiceTax, "'T:' || seq", "customer_id", "'TAX ON ' || reference",
			`FROM transactions t WHERE type = 'I' AND ${invoiceTax} > 0`),
		// A payment clears the invoice; an early-payment discount taken is
		// cash not received.
		...side("1000", "debit", `amount - ${discountTaken}`, "'T:' || seq", "customer_id", "'PAYMENT ' || reference",
			`FROM transactions t WHERE type = 'P' AND amount - ${discountTaken} <> 0`),
		...side("4100", "debit", discountTaken, "'T:' || seq", "customer_id", "'DISCOUNT ' || reference",
			`FROM transactions t WHERE type = 'P' AND ${discountTaken} > 0`),
		...pair("1000", "1200", "amount", "'T:' || seq", "customer_id", "'PAYMENT ' || reference", "FROM transactions t WHERE type = 'P'")
			.slice(1),
		...pair("5000", "1300", invoiceCost, "'C:' || seq", "reference", "'COST OF ' || reference",
			`FROM transactions t WHERE type = 'I' AND reference GLOB 'INV[0-9]*' AND ${invoiceCost} > 0`),
		...pair("1300", "2000", "quantity * unit_cost", "'R:' || seq", "po_id", "'RECEIVED ' || sku", "FROM receipts WHERE quantity * unit_cost > 0"),
		...pair("1300", "5100", "amount", "'A:' || seq", "sku", adjustMemo, "FROM stock_adjustments WHERE amount > 0"),
		...pair("5100", "1300", "-amount", "'A:' || seq", "sku", adjustMemo, "FROM stock_adjustments WHERE amount < 0"),
		...pair("5200", "2100", "freight_cost", "'F:' || id", "id", "'FREIGHT ' || carrier || ' ' || invoice_id",
			"FROM shipments WHERE status = 'S' AND carrier <> 'TRK' AND freight_cost > 0"),
		...pair("5210", "2110", "cost_miles + cost_labor", "'L:' || id", "id", "'TRUCK ' || truck_id || ' ' || actual_miles || ' MI'",
			"FROM loads WHERE status = 'C' AND cost_miles + cost_labor > 0"),
	];

	// Opening balances, once: what customers owed and the stock at cost
	// before any of the activity above. Stock on open invoices has left the
	// shelf but is still ours until the invoice is billed.
	const opened = await db.prepare("SELECT 1 FROM gl_entries WHERE source LIKE 'OPEN:%' LIMIT 1").first();
	if (!opened) {
		const row = await db.prepare(
			`SELECT
			   (SELECT COALESCE(SUM(balance), 0) FROM customers)
			   - (SELECT COALESCE(SUM(CASE type WHEN 'I' THEN amount ELSE -amount END), 0) FROM transactions) AS ar,
			   (SELECT COALESCE(SUM(on_hand * unit_cost), 0) FROM products)
			   - (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM receipts)
			   - (SELECT COALESCE(SUM(amount), 0) FROM stock_adjustments)
			   + (SELECT COALESCE(SUM(${invoiceCost}), 0) FROM transactions t WHERE type = 'I' AND reference GLOB 'INV[0-9]*')
			   + (SELECT COALESCE(SUM(l.quantity * p.unit_cost), 0) FROM invoice_lines l JOIN products p ON p.sku = l.sku
			      JOIN invoices i ON i.id = l.invoice_id WHERE i.status = 'O') AS inv`,
		).first<{ ar: number; inv: number }>();
		for (const [source, account, amount, memo] of [
			["OPEN:AR", "1200", row!.ar, "OPENING CUSTOMER BALANCES"],
			["OPEN:INV", "1300", row!.inv, "OPENING STOCK AT COST"],
		] as const) {
			if (amount === 0) continue;
			const [dr, cr] = amount > 0 ? [account, "3000"] : ["3000", account];
			stmts.push(...[dr, cr].map((acct, i) => db.prepare(
				`INSERT INTO gl_entries (period, account, debit, credit, source, reference, memo, posted, posted_by)
				 VALUES (?, ?, ?, ?, ?, '', ?, ?, ?) ON CONFLICT (source, account) DO NOTHING`,
			).bind(period, acct, i === 0 ? Math.abs(amount) : 0, i === 0 ? 0 : Math.abs(amount), source, memo, ts, by)));
		}
	}

	const results = await db.batch(stmts);
	const entries = results.reduce((n, r) => n + r.meta.changes, 0);
	const { results: sums } = await db.prepare(
		"SELECT account, SUM(debit) AS debit, SUM(credit) AS credit FROM gl_entries WHERE posted = ? AND posted_by = ? GROUP BY account",
	).bind(ts, by).all<{ account: string; debit: number; credit: number }>();
	return { period, entries, byAccount: new Map(sums.map((s) => [s.account, { debit: s.debit, credit: s.credit }])) };
}

// trialBalance returns every account's balance through the end of a
// period (the open one by default).
export async function trialBalance(db: D1Database, periodName = ""): Promise<TrialBalance> {
	const period = periodName
		? await db.prepare("SELECT * FROM gl_periods WHERE period = ?").bind(periodName).first<Period>()
		: await openPeriod(db);
	if (!period) throw new HttpError(404, "not_found", `period ${periodName} not found`);
	const { results } = await db.prepare(
		`SELECT a.*, COALESCE(SUM(e.debit - e.credit), 0) AS net,
		   COALESCE(SUM(CASE WHEN e.period = ?1 THEN e.debit - e.credit ELSE 0 END), 0) AS activity
		 FROM gl_accounts a LEFT JOIN gl_entries e ON e.account = a.account AND e.period <= ?1
		 GROUP BY a.account ORDER BY a.account`,
	).bind(period.period).all<Account & { net: number; activity: number }>();
	const rows = results.map(({ net, ...a }) => ({ ...a, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }));
	const extra = await db.prepare(
		`SELECT (SELECT COALESCE(SUM(balance), 0) FROM customers) AS subledger,
		   (SELECT COUNT(*) FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM gl_entries WHERE source = 'T:' || t.seq))
		   + (SELECT COUNT(*) FROM receipts r WHERE quantity * unit_cost > 0
		      AND NOT EXISTS (SELECT 1 FROM gl_entries WHERE source = 'R:' || r.seq))
		   + (SELECT COUNT(*) FROM stock_adjustments a WHERE amount <> 0
		      AND NOT EXISTS (SELECT 1 FROM gl_entries WHERE source = 'A:' || a.seq))
		   + (SELECT COUNT(*) FROM shipments h WHERE status = 'S' AND carrier <> 'TRK' AND freight_cost > 0
		      AND NOT EXISTS (SELECT 1 FROM gl_entries WHERE source = 'F:' || h.id))
		   + (SELECT COUNT(*) FROM loads l WHERE status = 'C' AND cost_miles + cost_labor > 0
		      AND NOT EXISTS (SELECT 1 FROM gl_entries WHERE source = 'L:' || l.id)) AS unjournaled`,
	).first<{ subledger: number; unjournaled: number }>();
	return {
		period, rows,
		debits: rows.reduce((t, r) => t + r.debit, 0),
		credits: rows.reduce((t, r) => t + r.credit, 0),
		subledger: extra!.subledger,
		unjournaled: extra!.unjournaled,
	};
}

// accountEntries returns an account's journal entries in a period, oldest
// first.
export async function accountEntries(db: D1Database, account: string, period: string): Promise<Entry[]> {
	const { results } = await db.prepare(
		"SELECT * FROM gl_entries WHERE account = ? AND period = ? ORDER BY seq LIMIT 1000",
	).bind(account, period).all<Entry>();
	return results;
}

// closePeriod closes the open period and opens the next.
export async function closePeriod(db: D1Database, by: string): Promise<{ closed: string; opened: string }> {
	const { period } = await openPeriod(db);
	const next = nextPeriod(period);
	await db.batch([
		db.prepare("UPDATE gl_periods SET status = 'C', closed = ?, closed_by = ? WHERE period = ? AND status = 'O'").bind(now(), by, period),
		db.prepare("INSERT OR IGNORE INTO gl_periods (period, status) VALUES (?, 'O')").bind(next),
	]);
	return { closed: period, opened: next };
}

// ---- batch job steps ----

const pad = (s: string | number, n: number, left = false) => {
	const v = String(s).slice(0, n);
	return left ? v.padStart(n) : v.padEnd(n);
};
const amt = (n: number) => (n ? "$" + n.toLocaleString("en-US") : "");

// journalStep is the first step of CUSCLOSE and CUSTRIAL.
export async function journalStep(db: D1Database, job: { name: string }): Promise<StepResult> {
	const { period, entries, byAccount } = await journal(db, job.name);
	const accounts = await listAccounts(db);
	const lines = ["", `JOURNAL ENTRIES POSTED TO PERIOD ${period}:`, "", "ACCT NAME                         DEBITS        CREDITS"];
	let d = 0;
	let c = 0;
	for (const a of accounts) {
		const s = byAccount.get(a.account);
		if (!s) continue;
		d += s.debit;
		c += s.credit;
		lines.push(`${a.account} ${pad(a.name, 24)} ${pad(amt(s.debit), 14, true)} ${pad(amt(s.credit), 14, true)}`);
	}
	if (entries === 0) lines.push("  NOTHING NEW TO JOURNAL");
	lines.push(`${pad("", 29)} ${pad(amt(d) || "$0", 14, true)} ${pad(amt(c) || "$0", 14, true)}`, "", `${entries} ENTRIES POSTED`);
	return { rc: d === c ? 0 : 8, lines };
}

// trialBalanceStep prints the trial balance for the open period. It warns
// if the receivables control account does not agree with what customers
// owe.
export async function trialBalanceStep(db: D1Database): Promise<StepResult> {
	return trialBalanceReport(await trialBalance(db));
}

// trialBalanceReport prints a trial balance, with a condition code of 8 if
// it is out of balance and 4 if receivables disagree with the customers.
export function trialBalanceReport(tb: TrialBalance): StepResult {
	const lines = [
		"",
		`TRIAL BALANCE AS OF PERIOD ${tb.period.period}`,
		"",
		"ACCT NAME                      TYPE              DEBIT         CREDIT",
		"---- ------------------------- --------- -------------- --------------",
	];
	for (const r of tb.rows) {
		lines.push(`${r.account} ${pad(r.name, 25)} ${pad(typeNames[r.type], 9)} ${pad(amt(r.debit), 14, true)} ${pad(amt(r.credit), 14, true)}`);
	}
	lines.push(
		"---- ------------------------- --------- -------------- --------------",
		`${pad("TOTALS", 40)} ${pad(amt(tb.debits) || "$0", 14, true)} ${pad(amt(tb.credits) || "$0", 14, true)}`,
		"",
		tb.debits === tb.credits ? "DEBITS EQUAL CREDITS - THE LEDGER IS IN BALANCE" : "*** DEBITS DO NOT EQUAL CREDITS ***",
	);
	const ar = tb.rows.find((r) => r.account === "1200");
	const control = ar ? ar.debit - ar.credit : 0;
	const agrees = control === tb.subledger;
	lines.push(
		`AR CONTROL ${amt(control) || "$0"}, CUSTOMER ACCOUNTS ${amt(tb.subledger) || "$0"} - ${agrees ? "AGREE" : "DO NOT AGREE"}`,
	);
	return { rc: tb.debits !== tb.credits ? 8 : agrees ? 0 : 4, lines };
}

// lastClosed returns the most recently closed period, if any.
export async function lastClosed(db: D1Database): Promise<Period | undefined> {
	return (await db.prepare("SELECT * FROM gl_periods WHERE status = 'C' ORDER BY period DESC LIMIT 1").first<Period>()) ?? undefined;
}

// closeStep is CUSCLOSE's last step.
export async function closeStep(db: D1Database, job: { name: string }): Promise<StepResult> {
	const { closed, opened } = await closePeriod(db, job.name);
	return { rc: 0, lines: ["", `PERIOD ${closed} CLOSED - PERIOD ${opened} IS NOW OPEN`] };
}

export { dunningLevels } from "./documents";

// holdAccount puts an active account on hold, recording the change in its
// history. It reports whether the account was active.
export async function holdAccount(db: D1Database, cust: string, ts: string, by: string): Promise<boolean> {
	const active = "id = ? AND status = 'A'";
	const [, hold] = await db.batch([
		db.prepare(
			`INSERT INTO audit (customer_id, action, field, old_value, new_value, at, by)
			 SELECT id, 'CHANGE', 'STATUS', 'A', 'H', ?, ? FROM customers WHERE ${active}`,
		).bind(ts, by, cust),
		db.prepare(`UPDATE customers SET status = 'H', version = version + 1, updated = ?, updated_by = ? WHERE ${active}`)
			.bind(ts, by, cust),
	]);
	return hold.meta.changes > 0;
}

// dunningLetters is CUSDUNN's step: a letter to each customer with an
// invoice that has reached a new dunning level, printed and filed in the
// archive as a PDF. A final notice also puts an active account on hold,
// recorded in the change history. Invoices with a lifecycle are dunned by
// it (lifecycle.ts), so the job only writes about the ones without.
export async function dunningLetters(db: D1Database, job: { name: string; submitted_by?: string }, archive?: R2Bucket): Promise<StepResult> {
	const at = Date.now();
	const { results } = await db.prepare(
		`SELECT i.id, i.customer_id, i.total, i.billed, i.po_number, c.name, c.address, c.city, c.state, c.zip, c.status
		 FROM invoices i JOIN customers c ON c.id = i.customer_id
		 WHERE i.status = 'B' AND i.billed <> '' AND i.billed < ?
		   AND NOT EXISTS (SELECT 1 FROM order_flows f WHERE f.kind = 'I' AND f.ref = i.id)
		 ORDER BY i.customer_id, i.billed`,
	).bind(new Date(at - 30 * DAY).toISOString()).all<{
		id: string; customer_id: string; total: number; billed: string; po_number: string;
		name: string; address: string; city: string; state: string; zip: string; status: string;
	}>();

	const letters = new Map<string, { letter: Letter; status: string }>();
	const ts = new Date(at).toISOString();
	for (const inv of results) {
		const days = Math.floor((at - Date.parse(inv.billed)) / DAY) - 30;
		const level = days > 60 ? 3 : days > 30 ? 2 : 1;
		const res = await db.prepare(
			`INSERT INTO dunning (customer_id, invoice_id, level, days, amount, sent, sent_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (invoice_id, level) DO NOTHING`,
		).bind(inv.customer_id, inv.id, level, days, inv.total, ts, job.name).run();
		if (res.meta.changes === 0) continue; // this level was already sent
		const got = letters.get(inv.customer_id) ?? {
			status: inv.status,
			letter: {
				level, sent: ts, invoices: [],
				customer: { id: inv.customer_id, name: inv.name, address: inv.address, city: inv.city, state: inv.state, zip: inv.zip },
			},
		};
		got.letter.level = Math.max(got.letter.level, level);
		got.letter.invoices.push({ id: inv.id, po_number: inv.po_number, billed: inv.billed, days, total: inv.total });
		letters.set(inv.customer_id, got);
	}

	const lines: string[] = [];
	let held = 0;
	for (const [cust, { letter, status }] of letters) {
		const text = letterLines(letter);
		lines.push(...text);
		if (archive) {
			await putArchive(db, archive, {
				key: `letters/${ts.slice(0, 10)}/${cust}-L${letter.level}`, kind: "D", ref: cust, name: job.name,
				title: `${dunningLevels[letter.level]} ${letter.customer.name}`.slice(0, 60), owner: job.submitted_by ?? job.name,
				created: ts, archived_by: job.name,
			}, text, letterPdf(letter));
		}
		if (letter.level === 3 && status === "A" && (await holdAccount(db, cust, ts, job.name))) held++;
	}
	if (letters.size === 0) lines.push("", "NO INVOICES HAVE REACHED A NEW DUNNING LEVEL");
	lines.push("", `${letters.size} DUNNING LETTERS PRINTED, ${held} ACCOUNTS PLACED ON HOLD`);
	return { rc: letters.size > 0 ? 4 : 0, lines };
}
