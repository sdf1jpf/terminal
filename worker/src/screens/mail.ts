import { getMail, listMail, statusColors, type Mail } from "../mail";
import { header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, value, type Ctx } from "./screen";
import { scroll } from "./spool";
import { fail, isCode, pf, type MailMsgState, type MailState, type Program } from "./program";

// CUSQ05 MAIL LOG lists mail sent (statements and dunning letters, as PDF
// attachments) and mail received from vendors. S shows one (CUSQ06).

const mailRows = (ctx: Ctx) => ctx.rows - 10;

function mailLine(seq: string, at: string, dir: string, status: string, ref: string, subject: string): string {
	return `${lpad(seq, 5)} ${pad(at, 16)} ${pad(dir, 3)} ${pad(status, 8)} ${pad(ref, 8)} ${subject}`;
}

export const mail: Program<MailState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ05");
		header(scr, ctx, "MAIL LOG");
		let msg = s.msg ?? "";
		label(scr, 4, 2, "CUSTOMER OR PO ===>");
		scr.input(4, 22, 8, "ref", s.ref ?? "");
		const to = ctx.env.MAIL_TO;
		scr.text(5, 2, to ? `OUTBOUND MAIL GOES TO ${to.toUpperCase()} FROM ${(ctx.env.MAIL_FROM ?? "").toUpperCase()}` : "MAIL IS NOT SET UP",
			{ color: to ? "blue" : "yellow" });

		let list: Mail[] = [];
		try {
			list = await listMail(ctx.db, s.ref ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = mailRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(6, 2, "S " + mailLine("SEQ", "WHEN", "DIR", "STATUS", "REF", "SUBJECT").slice(0, scr.cols - 5), { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((m, i) => {
			scr.input(8 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(8 + i, 4, mailLine(String(m.seq), stamp(ctx, m.at), m.direction === "O" ? "OUT" : "IN", m.status, m.ref, m.subject.toUpperCase())
				.slice(0, scr.cols - 5), { color: statusColors[m.status] });
		});
		if (list.length === 0) scr.text(8, 4, s.ref ? `NO MAIL FOR ${s.ref}` : "NO MAIL YET", { color: "yellow" });
		s.seqs = shown.map((m) => m.seq);

		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errSel) scr.cursorTo(s.errSel);
		else scr.cursorTo("ref");
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
				return s;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, mailRows(ctx), (await listMail(ctx.db, s.ref ?? "")).length);
				return s;
			case "CLEAR":
				s.ref = "";
				s.top = 0;
				return s;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const ref = (input.fields.ref ?? "").trim().toUpperCase();
		if (ref !== (s.ref ?? "")) {
			s.ref = ref;
			s.top = 0;
			return s;
		}
		for (const [i, seq] of (s.seqs ?? []).entries()) {
			const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code === "S") return { p: "mailmsg", back: s, seq };
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
			s.errSel = `sel${i}`;
			return s;
		}
		return s;
	},
};

// CUSQ06 MAIL MESSAGE shows one entry of the mail log.
export const mailmsg: Program<MailMsgState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSQ06");
		header(scr, ctx, "MAIL MESSAGE");
		let msg = s.msg ?? "";
		try {
			const m = await getMail(ctx.db, s.seq);
			const rows: [string, string][] = [
				["DIRECTION", m.direction === "O" ? "OUTBOUND" : "INBOUND"],
				["STATUS", m.status],
				["WHEN", stamp(ctx, m.at)],
				["FROM", m.sender],
				["TO", m.recipient],
				["SUBJECT", m.subject],
				["ABOUT", m.ref],
				["ATTACHMENT", m.archive_key ? `${m.archive_key}.pdf` : ""],
				["MESSAGE ID", m.message_id],
				["BY", m.by],
			];
			rows.forEach(([k, v], i) => {
				label(scr, 4 + i, 2, k.padEnd(12, "."));
				value(scr, 4 + i, 15, v.slice(0, scr.cols - 16));
			});
			if (m.detail) {
				label(scr, 15, 2, m.direction === "O" ? "ERROR" : "RESULT");
				for (let i = 0; i * (scr.cols - 4) < m.detail.length && i < 4; i++) {
					scr.text(16 + i, 4, m.detail.toUpperCase().slice(i * (scr.cols - 4), (i + 1) * (scr.cols - 4)),
						{ color: statusColors[m.status] });
				}
			}
		} catch (e) {
			msg = isCode(e, "not_found") ? `CUS1524E MAIL ${s.seq} IS NOT IN THE LOG` : fail(e);
		}
		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF12=CANCEL");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(_ctx, s, input) {
		s.msg = undefined;
		if (input.aid === pf(3) || input.aid === pf(12)) return s.back;
		if (input.aid !== "ENTER") s.msg = invalidKey(input.aid);
		return s;
	},
};
