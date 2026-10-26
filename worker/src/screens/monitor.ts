import { stats, windows, type Stats } from "../monitor";
import { clock, header, invalidKey, keys, lpad, message, newScreen, pad, right, type Ctx } from "./screen";
import { fail, isCode, pf, type MonitorState, type Program } from "./program";

// CUSO03 TRANSACTION MONITOR shows response times and transaction rates
// from Analytics Engine, the way CICS statistics and Omegamon show them:
// by transaction, or as a rate over time. A screen request counts as the
// transaction of the screen it sent; an API request as its route. It
// refreshes itself every 30 seconds. PF10 and PF11 shorten and lengthen
// the window, PF6 switches the view.

const REFRESH = 30; // seconds

// listRows is how many lines fit under the headings: 14 on 24x80.
const listRows = (ctx: Ctx) => ctx.rows - 10;

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function windowName(m: number): string {
	return m >= 60 ? `${m / 60} HOUR${m === 60 ? "" : "S"}` : `${m} MINUTES`;
}

export const monitor: Program<MonitorState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSO03");
		header(scr, ctx, "TRANSACTION MONITOR");
		const minutes = s.minutes ?? 15;
		const byTran = s.view !== "I";
		let msg = s.msg ?? "";

		let st: Stats | undefined;
		try {
			st = await stats(ctx.env, minutes, listRows(ctx));
		} catch (e) {
			msg = isCode(e, "unavailable") && /AE_API_TOKEN/.test((e as Error).message)
				? "CUS0811W TRANSACTION STATISTICS NOT SET UP - AE_API_TOKEN SECRET MISSING"
				: fail(e);
		}

		scr.text(3, 2, `INTERVAL: LAST ${windowName(minutes)}   VIEW: ${byTran ? "BY TRANSACTION" : "BY TIME"}`, { color: "white", bright: true });
		scr.text(3, right(scr, 59), `REFRESH EVERY ${REFRESH} SECONDS`, { color: "blue" });
		const t = st?.total;
		const summary = [
			["TRANS", t ? fmt(t.count) : "-"],
			["TPM", t ? fmt(t.tpm, 1) : "-"],
			["AVG RESP", t ? `${fmt(t.avg_ms)} MS` : "-"],
			["MAX", t ? `${fmt(t.max_ms)} MS` : "-"],
			["ABENDS", t ? fmt(t.abends) : "-"],
		];
		let col = 2;
		for (const [k, v] of summary) {
			scr.text(4, col, k, { color: "turquoise" });
			scr.text(4, col + k.length + 1, v, { color: t?.abends && k === "ABENDS" ? "red" : "green", bright: true });
			col += k.length + v.length + 4;
		}

		const rows = listRows(ctx);
		const lines = st ? (byTran ? st.trans.length : st.intervals.length) : 0;
		const top = Math.min(s.top ?? 0, Math.max(lines - rows, 0));
		s.top = top;
		if (lines > rows) scr.text(6, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, lines)} OF ${lines}`, { color: "white" });

		const width = scr.cols - 51; // the transaction name column
		if (byTran) {
			scr.text(7, 2, `${pad("TRANSACTION", width)} ${pad("TYPE", 6)} ${lpad("COUNT", 7)} ${lpad("TPM", 6)} ${lpad("AVG MS", 6)} ${lpad("P95 MS", 6)} ${lpad("MAX MS", 6)} ${lpad("ABND", 4)}`,
				{ color: "white", bright: true });
			scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			st?.trans.slice(top, top + rows).forEach((r, i) => {
				const line = `${pad(r.tran, width)} ${pad(r.kind, 6)} ${lpad(fmt(r.count), 7)} ${lpad(fmt(r.count / minutes, 1), 6)} ` +
					`${lpad(fmt(r.avg_ms), 6)} ${lpad(fmt(r.p95_ms), 6)} ${lpad(fmt(r.max_ms), 6)} ${lpad(fmt(r.abends), 4)}`;
				scr.text(9 + i, 2, line, { color: r.abends ? "red" : r.kind === "SCREEN" ? "green" : "turquoise" });
			});
		} else if (st) {
			scr.text(7, 2, `${pad("TIME", 14)} ${lpad("COUNT", 7)} ${lpad("TPM", 7)} ${lpad("AVG MS", 6)} ${lpad("ABND", 4)}  RATE`, { color: "white", bright: true });
			scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
			const peak = Math.max(1, ...st.intervals.map((r) => r.count));
			const bar = scr.cols - 47;
			st.intervals.slice(top, top + rows).forEach((r, i) => {
				const n = Math.max(r.count > 0 ? 1 : 0, Math.round((r.count / peak) * bar));
				scr.text(9 + i, 2, `${pad(clock(ctx, r.at), 14)} ${lpad(fmt(r.count), 7)} ${lpad(fmt(r.count / st!.bucket, 1), 7)} ${lpad(fmt(r.avg_ms), 6)} ${lpad(fmt(r.abends), 4)}`,
					{ color: r.abends ? "red" : "green" });
				scr.text(9 + i, 46, "#".repeat(n), { color: "turquoise" });
			});
		}
		if (st && lines === 0) scr.text(9, 2, `NO TRANSACTIONS IN THE LAST ${windowName(minutes)}`, { color: "yellow" });
		if (st) scr.refresh = REFRESH;

		message(scr, msg);
		keys(scr, "PF3=EXIT  PF5=REFRESH  PF6=VIEW  PF7=UP  PF8=DOWN  PF10=SHORTER  PF11=LONGER");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		const minutes = s.minutes ?? 15;
		const i = windows.indexOf(minutes);
		switch (input.aid) {
			case "ENTER":
			case pf(5):
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(6):
				s.view = s.view === "I" ? "T" : "I";
				s.top = 0;
				return s;
			case pf(7):
				if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
				s.top = Math.max((s.top ?? 0) - listRows(ctx), 0);
				return s;
			case pf(8):
				// render clamps it to the last page.
				s.top = (s.top ?? 0) + listRows(ctx);
				return s;
			case pf(10):
			case pf(11): {
				const j = input.aid === pf(10) ? i - 1 : i + 1;
				if (j < 0 || j >= windows.length) {
					s.msg = `CUS0812W ${windowName(minutes)} IS THE ${j < 0 ? "SHORTEST" : "LONGEST"} INTERVAL`;
					return s;
				}
				s.minutes = windows[j];
				s.top = 0;
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
