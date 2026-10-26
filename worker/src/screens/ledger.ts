import { submitJob } from "../jobs";
import { accountEntries, listAccounts, trialBalance, typeNames, type Entry, type TrialBalance } from "../ledger";
import { header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, type Ctx } from "./screen";
import { fail, isCode, pf, type GLAccountState, type LedgerState, type Program, type State } from "./program";

// CUSA01 GENERAL LEDGER shows the trial balance for a period (the open one
// by default), checks the receivables control account against what
// customers owe, and submits the month-end close (CUSCLOSE), the dunning
// run (CUSDUNN) and the trial balance job (CUSTRIAL), which journals the
// latest activity. S on an account opens CUSA02 ACCOUNT LEDGER, its entries
// in the period.

// accountRows is how many accounts fit above the totals.
const accountRows = (ctx: Ctx) => ctx.rows - 16;

const amt = (n: number) => (n ? money(n) : "");

function tbLine(acct: string, name: string, type: string, activity: string, debit: string, credit: string): string {
	return `${pad(acct, 4)} ${pad(name, 22)} ${pad(type, 9)} ${lpad(activity, 12)} ${lpad(debit, 12)} ${lpad(credit, 12)}`;
}

export function newLedger(back: State, period = ""): LedgerState {
	return { p: "ledger", back, period: period.trim() };
}

async function load(ctx: Ctx, period: string): Promise<TrialBalance | string> {
	try {
		return await trialBalance(ctx.db, period);
	} catch (e) {
		return isCode(e, "not_found") ? `CUS0901E PERIOD ${period} NOT FOUND` : fail(e);
	}
}

export const ledger: Program<LedgerState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSA01");
		header(scr, ctx, "GENERAL LEDGER");
		const tb = await load(ctx, s.period ?? "");
		let msg = s.msg ?? "";

		label(scr, 4, 2, "PERIOD ===>");
		if (typeof tb === "string") {
			msg = msg || tb;
			scr.input(4, 14, 7, "period", s.period ?? "", { bright: true });
		} else {
			const p = tb.period;
			scr.input(4, 14, 7, "period", p.period, { bright: s.errField === "period" });
			scr.text(4, 23, p.status === "O" ? "OPEN" : "CLOSED", { color: p.status === "O" ? "white" : "turquoise", bright: true });
			if (p.closed) scr.text(4, right(scr, 44), lpad(`CLOSED ${stamp(ctx, p.closed)} BY ${p.closed_by}`, 36), { color: "green" });
			scr.text(5, 2, "SELECT: S=ACCOUNT ENTRIES       BALANCES ARE AS OF THE END OF THE PERIOD", { color: "blue" });
			scr.text(7, 2, "S " + tbLine("ACCT", "NAME", "TYPE", "IN PERIOD", "DEBIT", "CREDIT"), { color: "white", bright: true });
			scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			// The accounts scroll above the totals, which keep to the bottom.
			const rows = accountRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(tb.rows.length - rows, 0));
			if (tb.rows.length > rows) {
				scr.text(6, 2, `ACCOUNTS ${top + 1} TO ${Math.min(top + rows, tb.rows.length)} OF ${tb.rows.length} - PF7/PF8 SCROLL`, { color: "white" });
			}
			tb.rows.slice(top, top + rows).forEach((r, i) => {
				scr.input(9 + i, 2, 1, "sel:" + r.account, "", { bright: s.errSel === r.account });
				scr.text(9 + i, 4, tbLine(r.account, r.name, typeNames[r.type], amt(r.activity), amt(r.debit), amt(r.credit)), { color: "green" });
			});
			const row = 10 + Math.min(rows, tb.rows.length);
			scr.text(row - 1, 4, tbLine("", "", "", "", "-".repeat(12), "-".repeat(12)), { color: "blue" });
			scr.text(row, 4, tbLine("", "TOTALS", "", "", money(tb.debits), money(tb.credits)), { color: "white", bright: true });
			const balanced = tb.debits === tb.credits;
			scr.text(row + 2, 4, balanced ? "DEBITS EQUAL CREDITS - THE LEDGER IS IN BALANCE" : "*** DEBITS DO NOT EQUAL CREDITS ***",
				{ color: balanced ? "green" : "red", bright: !balanced });
			const ar = tb.rows.find((r) => r.account === "1200");
			const control = ar ? ar.debit - ar.credit : 0;
			if (p.status === "O") {
				const agrees = control === tb.subledger;
				scr.text(row + 3, 4, `AR CONTROL ${money(control)}  CUSTOMER ACCOUNTS ${money(tb.subledger)}  ${agrees ? "AGREE" : "DO NOT AGREE"}`,
					{ color: agrees ? "green" : "yellow" });
				if (tb.unjournaled > 0) {
					scr.text(row + 4, 4, `${tb.unjournaled} POSTINGS AND RECEIPTS NOT YET JOURNALED - PF10 JOURNALS THEM`, { color: "yellow" });
				}
			}
		}
		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF5=CLOSE MONTH PF6=DUNNING PF10=TRIAL BALANCE PF12=CANCEL");
		if (s.errField || typeof tb === "string") scr.cursorTo("period");
		else scr.cursorTo("sel:" + (s.errSel ?? tb.rows[0]?.account ?? ""));
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errSel = s.errField = s.confirm = undefined;
		const typed = (input.fields.period ?? "").trim();
		if (input.aid === "ENTER" && input.modified.has("period")) {
			if (typed && !/^\d{4}-\d{2}$/.test(typed)) {
				s.msg = "CUS0902E PERIOD MUST BE YYYY-MM, SUCH AS 2026-10";
				s.errField = "period";
				return s;
			}
			s.period = typed;
			return s;
		}
		const submit = async (name: string) => {
			try {
				const job = await submitJob(ctx.db, ctx.jobs, ctx.user, name);
				s.msg = `$HASP100 ${name} ON INTRDR - ${job.id} SUBMITTED - PRESS ENTER IN A MOMENT`;
			} catch (e) {
				s.msg = fail(e);
			}
			return s;
		};
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const account = name.slice(4);
					if (code !== "S") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = account;
						return s;
					}
					const tb = await load(ctx, s.period ?? "");
					if (typeof tb === "string") return s;
					return { p: "glaccount", back: s, account, period: tb.period.period };
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				if (!confirm) {
					s.confirm = true;
					s.msg = "CUS0903W PRESS PF5 AGAIN TO RUN THE MONTH-END CLOSE AND CLOSE THE PERIOD";
					return s;
				}
				s.period = "";
				return submit("CUSCLOSE");
			case pf(6):
				return submit("CUSDUNN");
			case pf(10):
				return submit("CUSTRIAL");
			case pf(7):
			case pf(8): {
				const tb = await load(ctx, s.period ?? "");
				const total = typeof tb === "string" ? 0 : tb.rows.length;
				const rows = accountRows(ctx);
				if (input.aid === pf(7)) {
					if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
					s.top = Math.max((s.top ?? 0) - rows, 0);
				} else if ((s.top ?? 0) + rows >= total) {
					s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				} else {
					s.top = Math.min((s.top ?? 0) + rows, total - rows);
				}
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// ---- CUSA02 ACCOUNT LEDGER ----

const entryRows = (ctx: Ctx) => ctx.rows - 11;

function entryLine(seq: string, date: string, source: string, ref: string, memo: string, debit: string, credit: string): string {
	return `${lpad(seq, 6)} ${pad(date, 10)} ${pad(source, 9)} ${pad(ref, 8)} ${pad(memo, 18)} ${lpad(debit, 11)} ${lpad(credit, 11)}`;
}

export const glaccount: Program<GLAccountState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSA02");
		header(scr, ctx, "ACCOUNT LEDGER");
		let msg = s.msg ?? "";
		let list: Entry[] = [];
		let name = "";
		try {
			list = await accountEntries(ctx.db, s.account, s.period);
			name = (await listAccounts(ctx.db)).find((a) => a.account === s.account)?.name ?? "(NOT ON FILE)";
		} catch (e) {
			msg = fail(e);
		}
		const rows = entryRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		label(scr, 4, 2, "ACCOUNT");
		scr.text(4, 10, `${s.account} ${name}`, { color: "white", bright: true });
		label(scr, 4, right(scr, 52), "PERIOD");
		scr.text(4, right(scr, 59), s.period, { color: "white" });
		const d = list.reduce((t, e) => t + e.debit, 0);
		const c = list.reduce((t, e) => t + e.credit, 0);
		scr.text(5, 2, `DEBITS ${money(d)}   CREDITS ${money(c)}   NET ${money(d - c)}`, { color: "green" });
		if (list.length > rows) scr.text(5, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		scr.text(7, 2, entryLine("SEQ", "POSTED", "SOURCE", "REF", "MEMO", "DEBIT", "CREDIT"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((e, i) => {
			scr.text(9 + i, 2, entryLine(String(e.seq), stamp(ctx, e.posted).slice(0, 10), e.source, e.reference, e.memo, amt(e.debit), amt(e.credit)),
				{ color: "green" });
		});
		if (list.length === 0) scr.text(9, 4, "NO ENTRIES IN THIS PERIOD", { color: "yellow" });
		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case "ENTER":
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8): {
				const rows = entryRows(ctx);
				const total = (await accountEntries(ctx.db, s.account, s.period)).length;
				if (input.aid === pf(7)) {
					if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
					s.top = Math.max((s.top ?? 0) - rows, 0);
				} else if ((s.top ?? 0) + rows >= total) {
					s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				} else {
					s.top = Math.min((s.top ?? 0) + rows, total - rows);
				}
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
