import { getOutput, listOutput, pageOf, printOutput, purgeOutput, PRINTER, type Output } from "../spool";
import { header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, type Ctx } from "./screen";
import { fail, isCode, pf, withDownload, type OutputState, type Program, type SpoolState } from "./program";

// CUSQ01 HELD OUTPUT lists the print spool, like SDSF's H panel: job output
// listings and reports printed from screens. S browses one (CUSQ02), O
// prints it on PRT1 (again, for a reprint), D sends it to the terminal as a
// PDF on green-bar paper, and P purges it. PF6 opens the archive (CUSQ03).

// spoolRows is how many output groups fit on a page: 13 on 24x80.
const spoolRows = (ctx: Ctx) => ctx.rows - 11;

function spoolLine(name: string, id: string, owner: string, status: string, lines: string, copies: string, created: string, title: string): string {
	return `${pad(name, 8)} ${pad(id, 8)} ${pad(owner, 8)} ${pad(status, 7)} ${lpad(lines, 5)} ${lpad(copies, 3)} ${pad(created, 16)} ${title}`;
}

export function scroll(s: { top?: number; msg?: string }, aid: string, rows: number, total: number): void {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		s.top = Math.max((s.top ?? 0) - rows, 0);
	} else if ((s.top ?? 0) + rows >= total) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
	} else {
		s.top = Math.min((s.top ?? 0) + rows, total - rows);
	}
}

export const spool: Program<SpoolState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ01");
		header(scr, ctx, "HELD OUTPUT QUEUE");
		let msg = s.msg ?? "";

		label(scr, 4, 2, "JOBNAME STARTS WITH ===>");
		scr.input(4, 27, 8, "filter", s.filter ?? "");

		let list: Output[] = [];
		try {
			list = await listOutput(ctx.db, s.filter ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = spoolRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, `SELECT: S=BROWSE  O=PRINT ON ${PRINTER}  D=PDF  I=IMAGE  P=PURGE`, { color: "blue" });
		scr.text(7, 2, "S " + spoolLine("JOBNAME", "JOBID", "OWNER", "STATUS", "LINES", "CPY", "CREATED", "TITLE").slice(0, scr.cols - 5),
			{ color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((o, i) => {
			scr.input(9 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(9 + i, 4, spoolLine(o.name, o.id, o.owner, o.status, String(o.lines), String(o.copies), stamp(ctx, o.created), o.title)
				.slice(0, scr.cols - 5), { color: o.status === "HELD" ? "green" : "turquoise" });
		});
		if (list.length === 0) scr.text(9, 4, s.filter ? `NO OUTPUT FOR JOBS STARTING ${s.filter}` : "NO OUTPUT ON THE SPOOL", { color: "yellow" });
		s.ids = list.slice(top, top + rows).map((o) => o.id);

		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF1=HELP  PF3=EXIT  PF5=REFRESH  PF6=ARCHIVE  PF7/8=SCROLL");
		if (s.errSel) scr.cursorTo(s.errSel);
		else scr.cursorTo("filter");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.msg = "CUS0402I OUTPUT QUEUE REFRESHED";
				return s;
			case pf(6):
				return { p: "archive", back: s };
			case pf(7):
			case pf(8):
				scroll(s, input.aid, spoolRows(ctx), (await listOutput(ctx.db, s.filter ?? "")).length);
				return s;
			case "CLEAR":
				s.filter = "";
				s.top = 0;
				return s;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}

		const filter = (input.fields.filter ?? "").trim().toUpperCase();
		if (filter !== (s.filter ?? "")) {
			s.filter = filter;
			s.top = 0;
			return s;
		}
		for (const [i, id] of (s.ids ?? []).entries()) {
			const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			try {
				switch (code) {
					case "S":
						return { p: "output", back: s, id };
					case "O": {
						const o = await printOutput(ctx.db, ctx.user, id);
						s.msg = `$HASP150 ${o.name} ${o.id} ON ${PRINTER} - ${o.lines} LINES, COPY ${o.copies}`;
						return s;
					}
					case "D":
						s.msg = `CUS1501I ${id}.PDF SENT TO YOUR TERMINAL`;
						return withDownload(s, { url: `/v1/spool/${id}/pdf`, name: `${id}.pdf` });
					case "I":
						s.msg = `CUS1530I ${id} PAGE 1 SENT TO YOUR TERMINAL AS A PICTURE`;
						return withDownload(s, { url: `/v1/spool/${id}/png?page=1`, name: `${id}-P1.png` });
					case "P":
						await purgeOutput(ctx.db, ctx.user, id);
						s.msg = `$HASP250 ${id} PURGED`;
						return s;
				}
			} catch (e) {
				s.msg = isCode(e, "not_found") ? `CUS0401E ${id} IS NO LONGER ON THE SPOOL` : fail(e);
				return s;
			}
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			s.errSel = `sel${i}`;
			return s;
		}
		return s; // Enter alone refreshes
	},
};

// outputRows is how many listing lines fit on a page: 18 on 24x80.
const outputRows = (ctx: Ctx) => ctx.rows - 6;

// CUSQ02 OUTPUT DISPLAY browses one output group. PF4 prints it, PF10
// sends it to the terminal as a PDF.
export const output: Program<OutputState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ02");
		header(scr, ctx, "OUTPUT DISPLAY");
		let msg = s.msg ?? "";
		try {
			const { output: o, lines } = await getOutput(ctx.db, s.id);
			label(scr, 3, 2, `${o.name}  ${o.id}  ${o.status}${o.copies ? ` (${o.copies} PRINTED)` : ""}  ${o.title}`.slice(0, scr.cols - 26));
			const rows = outputRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(3, right(scr, 58), `LINE ${lpad(top + 1, 4)} OF ${lines.length}`, { color: "white" });
			lines.slice(top, top + rows).forEach((text, i) => {
				scr.text(4 + i, 2, text.slice(0, scr.cols - 2), { color: text.startsWith("IEF450I") ? "red" : "green" });
			});
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS0401E ${s.id} IS NO LONGER ON THE SPOOL` : fail(e);
		}
		message(scr, msg);
		keys(scr, "PF1=HELP PF3=EXIT PF4=PRINT PF7=UP PF8=DOWN PF10=PDF PF11=IMAGE PF12=CANCEL");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case "ENTER":
			case pf(5):
				return s;
			case pf(4):
				try {
					const o = await printOutput(ctx.db, ctx.user, s.id);
					s.msg = `$HASP150 ${o.name} ${o.id} ON ${PRINTER} - ${o.lines} LINES, COPY ${o.copies}`;
				} catch (e) {
					s.msg = isCode(e, "not_found") ? `CUS0401E ${s.id} IS NO LONGER ON THE SPOOL` : fail(e);
				}
				return s;
			case pf(10):
				s.msg = `CUS1501I ${s.id}.PDF SENT TO YOUR TERMINAL`;
				return withDownload(s, { url: `/v1/spool/${s.id}/pdf`, name: `${s.id}.pdf` });
			case pf(11): {
				// The printed page the top line on the screen is on.
				const n = pageOf(s.top ?? 0);
				s.msg = `CUS1530I ${s.id} PAGE ${n} SENT TO YOUR TERMINAL AS A PICTURE`;
				return withDownload(s, { url: `/v1/spool/${s.id}/png?page=${n}`, name: `${s.id}-P${n}.png` });
			}
			case pf(7):
			case pf(8): {
				const total = await getOutput(ctx.db, s.id).then((g) => g.lines.length, () => 0);
				scroll(s, input.aid, outputRows(ctx), total);
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
