import { archiveLines, getEntry, kindNames, listArchive, restoreArchive, type Entry, type Kind } from "../archive";
import { header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, type Ctx } from "./screen";
import { scroll } from "./spool";
import { fail, isCode, pf, withDownload, type ArchDocState, type ArchiveState, type Program } from "./program";

// CUSQ03 ARCHIVE lists what has been filed in the archive (R2): output
// moved off the spool after a week, statements, dunning letters and the
// month-end reports. S browses an entry (CUSQ04), D sends its PDF to the
// terminal, and R puts an archived listing back on the spool, held.

const archiveRows = (ctx: Ctx) => ctx.rows - 11;

function archiveLine(name: string, ref: string, kind: string, lines: string, archived: string, title: string): string {
	return `${pad(name, 8)} ${pad(ref, 8)} ${pad(kind, 9)} ${lpad(lines, 5)} ${pad(archived, 16)} ${title}`;
}

const fileName = (key: string) => key.split("/").slice(1).join("-");

export const archive: Program<ArchiveState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ03");
		header(scr, ctx, "ARCHIVED OUTPUT AND DOCUMENTS");
		let msg = s.msg ?? "";

		label(scr, 4, 2, "NAME OR REF ===>");
		scr.input(4, 19, 8, "filter", s.filter ?? "");
		label(scr, 4, 29, "KIND ===>");
		scr.input(4, 39, 1, "kind", s.kind ?? "", { bright: s.errField === "kind" });
		scr.text(5, 2, "KIND: L=LISTING  M=MONTH-END  S=STATEMENT  D=DUNNING LETTER  BLANK=ALL", { color: "blue" });

		let list: Entry[] = [];
		try {
			list = await listArchive(ctx.db, s.filter ?? "", s.kind ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = archiveRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, "SELECT: S=BROWSE  D=PDF  R=RESTORE TO THE SPOOL (LISTINGS)", { color: "blue" });
		scr.text(7, 2, "S " + archiveLine("NAME", "REF", "KIND", "LINES", "ARCHIVED", "TITLE").slice(0, scr.cols - 5),
			{ color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((e, i) => {
			scr.input(9 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(9 + i, 4, archiveLine(e.name, e.ref, kindNames[e.kind], String(e.lines), stamp(ctx, e.archived), e.title)
				.slice(0, scr.cols - 5), { color: e.kind === "L" ? "green" : "turquoise" });
		});
		if (list.length === 0) scr.text(9, 4, s.filter || s.kind ? "NOTHING ARCHIVED MATCHES" : "THE ARCHIVE IS EMPTY", { color: "yellow" });
		s.keys = shown.map((e) => e.key);

		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel) scr.cursorTo(s.errSel);
		else if (s.errField) scr.cursorTo(s.errField);
		else scr.cursorTo("filter");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, archiveRows(ctx), (await listArchive(ctx.db, s.filter ?? "", s.kind ?? "")).length);
				return s;
			case "CLEAR":
				s.filter = s.kind = "";
				s.top = 0;
				return s;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}

		const filter = (input.fields.filter ?? "").trim().toUpperCase();
		const kind = (input.fields.kind ?? "").trim().toUpperCase();
		if (kind && !(kind in kindNames)) {
			s.msg = `CUS1503E KIND "${kind}" IS NOT L, M, S OR D`;
			s.errField = "kind";
			return s;
		}
		if (filter !== (s.filter ?? "") || kind !== (s.kind ?? "")) {
			s.filter = filter;
			s.kind = kind as Kind | "";
			s.top = 0;
			return s;
		}
		for (const [i, key] of (s.keys ?? []).entries()) {
			const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			try {
				switch (code) {
					case "S":
						return { p: "archdoc", back: s, key };
					case "D":
						s.msg = `CUS1501I ${fileName(key)}.PDF SENT TO YOUR TERMINAL`;
						return withDownload(s, { url: `/v1/archive/${key}.pdf`, name: `${fileName(key)}.pdf` });
					case "R": {
						const o = await restoreArchive(ctx.db, ctx.env.ARCHIVE, ctx.user, key);
						s.msg = `CUS1504I ${o.id} RESTORED TO THE SPOOL, HELD - ${o.lines} LINES`;
						return s;
					}
				}
			} catch (e) {
				s.msg = isCode(e, "not_found") ? `CUS1505E ${key} IS NO LONGER IN THE ARCHIVE`
					: isCode(e, "invalid") || isCode(e, "conflict") ? `CUS1506E ${e.message.toUpperCase()}` : fail(e);
				s.errSel = `sel${i}`;
				return s;
			}
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			s.errSel = `sel${i}`;
			return s;
		}
		return s;
	},
};

const docRows = (ctx: Ctx) => ctx.rows - 6;

// CUSQ04 ARCHIVED DOCUMENT browses an entry's text, read back from R2.
// PF10 sends its PDF.
export const archdoc: Program<ArchDocState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ04");
		header(scr, ctx, "ARCHIVED DOCUMENT");
		let msg = s.msg ?? "";
		try {
			const e = await getEntry(ctx.db, s.key);
			const lines = await archiveLines(ctx.env.ARCHIVE, s.key);
			label(scr, 3, 2, `${e.name}  ${e.ref}  ${kindNames[e.kind]}  ${e.title}`.slice(0, scr.cols - 26));
			const rows = docRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(3, right(scr, 58), `LINE ${lpad(top + 1, 4)} OF ${lines.length}`, { color: "white" });
			lines.slice(top, top + rows).forEach((text, i) => scr.text(4 + i, 2, text.slice(0, scr.cols - 2), { color: "green" }));
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS1505E ${s.key} IS NO LONGER IN THE ARCHIVE` : fail(e);
		}
		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF10=PDF  PF12=CANCEL");
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
				return s;
			case pf(10):
				s.msg = `CUS1501I ${fileName(s.key)}.PDF SENT TO YOUR TERMINAL`;
				return withDownload(s, { url: `/v1/archive/${s.key}.pdf`, name: `${fileName(s.key)}.pdf` });
			case pf(7):
			case pf(8): {
				const total = await archiveLines(ctx.env.ARCHIVE, s.key).then((l) => l.length, () => 0);
				scroll(s, input.aid, docRows(ctx), total);
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
