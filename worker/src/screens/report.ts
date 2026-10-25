import { listCustomers } from "../data";
import type { Customer } from "../customer";
import { spoolReport } from "../spool";
import { dots, header, invalidKey, keys, label, lpad, message, MIN_COLS, money, newScreen, pad, right, textLines, time, value, type Color } from "./screen";
import { fail, pf, type Program, type ReportState } from "./program";

// A read-only credit exposure summary.

export const report: Program<ReportState> = {
	async render(ctx, r) {
		const scr = newScreen(ctx, "CUSR01");
		header(scr, ctx, "CREDIT EXPOSURE SUMMARY");

		let list: Customer[] = [];
		let msg = r.msg ?? "";
		try {
			list = await listCustomers(ctx.db, "");
		} catch (e) {
			msg = fail(e);
		}
		let limit = 0;
		let bal = 0;
		const status: Record<string, number> = {};
		for (const c of list) {
			limit += c.credit_limit;
			bal += c.balance;
			status[c.status] = (status[c.status] ?? 0) + 1;
		}
		label(scr, 4, 4, dots("CUSTOMERS ON FILE", 24));
		value(scr, 4, 30, lpad(list.length, 12));
		label(scr, 5, 4, dots("TOTAL CREDIT LIMIT", 24));
		value(scr, 5, 30, lpad(money(limit), 12));
		label(scr, 6, 4, dots("TOTAL OUTSTANDING", 24));
		value(scr, 6, 30, lpad(money(bal), 12));
		if (limit > 0) {
			label(scr, 7, 4, dots("OVERALL UTILIZATION", 24));
			value(scr, 7, 30, lpad(Math.trunc((bal * 100) / limit), 11) + "%");
		}
		const col = right(scr, 50);
		const counts: [string, string, Color][] = [["ACTIVE", "A", "green"], ["ON HOLD", "H", "yellow"], ["CLOSED", "C", "pink"]];
		counts.forEach(([name, code, color], i) => {
			label(scr, 4 + i, col, name);
			scr.text(4 + i, col + 10, lpad(status[code] ?? 0, 5), { color });
		});

		// The list fills rows 11 to three above the bottom, and the bars take
		// up any extra width: 10 rows of 30 on a 24x80 screen.
		const top = scr.rows - 14;
		const width = 30 + scr.cols - MIN_COLS;
		const sorted = [...list].sort((a, b) => b.balance - a.balance);
		scr.text(9, 4, "TOP EXPOSURES                   BALANCE  UTILIZATION", { color: "white", bright: true });
		scr.text(10, 4, "-".repeat(scr.cols - 6), { color: "blue" });
		sorted.slice(0, top).forEach((c, i) => {
			const pct = c.credit_limit > 0 ? Math.trunc((c.balance * 100) / c.credit_limit) : 0;
			const bar = Math.max(Math.min(Math.trunc((pct * width) / 100), width), 0);
			const color: Color = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
			value(scr, 11 + i, 4, `${pad(c.name, 24)} ${lpad(money(c.balance), 14)} ${lpad(pct, 4)}%`);
			scr.text(11 + i, 51, "#".repeat(bar) + ".".repeat(width - bar), { color });
		});

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF9=PRINT  PF12=CANCEL");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, r, input) {
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return { p: "menu" };
			case pf(5):
			case "ENTER":
			case "CLEAR":
				r.msg = "CUS0301I REPORT REFRESHED AT " + time(ctx);
				return r;
			case pf(9): {
				// The report goes to the spool as it is now, at 80 columns.
				const lines = textLines(await report.render({ ...ctx, rows: 24, cols: MIN_COLS }, { p: "report" }));
				const id = await spoolReport(ctx.db, ctx.user, "CUSR01", "CREDIT EXPOSURE SUMMARY", lines);
				r.msg = `CUS0302I REPORT PRINTED TO THE SPOOL AS ${id} - SEE OPTION H`;
				return r;
			}
		}
		r.msg = invalidKey(input.aid);
		return r;
	},
};
