import { getInterchange, listInterchanges, typeNames, type Interchange } from "../edi";
import { submitJob } from "../jobs";
import { padID } from "./detail";
import { dots, header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, value, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type EdiDocState, type EdiState, type Program, type State } from "./program";

// CUSE01 EDI MAILBOX lists the X12 interchanges exchanged with customers'
// systems, newest first, and runs the trading partner simulator (EDISIM).
// CUSE02 EDI INTERCHANGE shows one, segment by segment.

const statusColors: Record<string, Color> = {
	RECEIVED: "white", PROCESSING: "white", ACCEPTED: "green", REJECTED: "red", SENT: "turquoise",
};

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(id: string, dir: string, type: string, partner: string, status: string, ref: string, at: string): string {
	return `${pad(id, 8)} ${pad(dir, 3)} ${pad(type, 4)} ${pad(partner, 7)} ${pad(status, 10)} ${pad(ref, 24)} ${at}`;
}

export function newEdi(back: State, partner = ""): EdiState {
	return { p: "edi", back, partner: partner.trim() ? padID(partner) : "" };
}

const invoiceIn = (ref: string) => ref.match(/INV\d{5}/)?.[0] ?? "";

export const edi: Program<EdiState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSE01");
		header(scr, ctx, "EDI MAILBOX");
		let msg = s.msg ?? "";
		let list: Interchange[] = [];
		try {
			list = await listInterchanges(ctx.db, s.partner ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "PARTNER (CUSTOMER) ===>");
		scr.input(4, 26, 6, "partner", s.partner ?? "", { numeric: true, bright: s.errField === "partner" });
		if (list.length > 0) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, "SELECT: S=SHOW    850 PO IN, 997 ACK OUT, 810 INVOICE OUT, 820 PAYMENT IN", { color: "blue" });
		scr.text(7, 2, "S " + listLine("ID", "DIR", "TYPE", "PARTNER", "STATUS", "REFERENCE", "RECEIVED/SENT"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((x, i) => {
			scr.input(9 + i, 2, 1, "sel:" + x.id, "", { bright: s.errSel === x.id });
			scr.text(9 + i, 4, listLine(x.id, x.direction === "I" ? "IN" : "OUT", x.type, x.partner || "?", x.status, x.reference,
				stamp(ctx, x.created).slice(5)), { color: statusColors[x.status] ?? "green" });
		});
		if (list.length === 0) scr.text(9, 4, "THE MAILBOX IS EMPTY - PF6 HAS THE TRADING PARTNERS SEND ORDERS", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF6=RUN PARTNERS  PF7=UP  PF8=DOWN");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.errSel && shown.some((x) => x.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		else scr.cursorTo("partner");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const typed = (input.fields.partner ?? "").trim();
		const partner = typed ? padID(typed) : "";
		if (input.aid === "ENTER" && input.modified.has("partner") && partner !== (s.partner ?? "")) {
			s.partner = partner;
			s.top = 0;
			return s;
		}
		switch (input.aid) {
			case "ENTER":
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const id = name.slice(4);
					if (code !== "S") {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = id;
						return s;
					}
					return { p: "edidoc", back: s, id };
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.msg = "CUS0601I MAILBOX REFRESHED";
				return s;
			case pf(6):
				try {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, "EDISIM");
					s.msg = `$HASP100 EDISIM ON INTRDR - ${job.id} SUBMITTED - PRESS PF5 IN A MOMENT`;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await listInterchanges(ctx.db, s.partner ?? "")).length;
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

// ---- CUSE02 EDI INTERCHANGE ----

const docRows = (ctx: Ctx) => ctx.rows - 13;

async function load(ctx: Ctx, id: string): Promise<Interchange | string> {
	try {
		return await getInterchange(ctx.db, id);
	} catch (e) {
		return isCode(e, "not_found") ? `CUS0602E INTERCHANGE ${id} NOT FOUND` : fail(e);
	}
}

export const edidoc: Program<EdiDocState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSE02");
		header(scr, ctx, "EDI INTERCHANGE");
		const x = await load(ctx, s.id);
		let msg = s.msg ?? "";
		if (typeof x === "string") {
			msg = x;
		} else {
			const dir = x.direction === "I" ? "INBOUND FROM" : "OUTBOUND TO";
			label(scr, 4, 4, dots("INTERCHANGE", 12));
			scr.text(4, 18, `${x.id}  ${x.type} ${typeNames[x.type] ?? "UNKNOWN"}`, { color: "white", bright: true });
			scr.text(4, right(scr, 68), lpad(x.status, 10), { color: statusColors[x.status] ?? "green", bright: true });
			label(scr, 5, 4, dots("PARTNER", 12));
			value(scr, 5, 18, `${dir} ${x.partner || "(UNKNOWN SENDER)"}  CONTROL ${x.control}`);
			label(scr, 6, 4, dots("REFERENCE", 12));
			value(scr, 6, 18, `${x.reference || "(NONE)"}   ${stamp(ctx, x.created)} BY ${x.created_by}`);
			if (x.note) scr.text(7, 4, x.note, { color: "red", bright: true });

			const segs = x.raw.split(/~\s*/).map((t) => t.trim()).filter(Boolean);
			const rows = docRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(segs.length - rows, 0));
			scr.text(9, 4, "X12 SEGMENTS", { color: "white", bright: true });
			if (segs.length > rows) scr.text(9, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, segs.length)} OF ${segs.length}`, { color: "white" });
			scr.text(10, 4, "-".repeat(scr.cols - 6), { color: "blue" });
			segs.slice(top, top + rows).forEach((seg, i) => {
				const color: Color = /^(ISA|GS|GE|IEA)\*/.test(seg) ? "blue" : /^(ST|SE)\*/.test(seg) ? "turquoise" : "green";
				scr.text(11 + i, 4, (seg + "~").slice(0, scr.cols - 6), { color });
			});
		}
		message(scr, msg);
		const inv = typeof x === "string" ? "" : invoiceIn(x.reference);
		keys(scr, `PF1=HELP  PF3=EXIT  ${inv ? "PF4=SHOW INVOICE  " : ""}PF7=UP  PF8=DOWN  PF12=CANCEL`);
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
			case pf(4): {
				const x = await load(ctx, s.id);
				const inv = typeof x === "string" ? "" : invoiceIn(x.reference);
				if (inv) return { p: "invoice", back: s, id: inv };
				break;
			}
			case pf(7):
			case pf(8): {
				const x = await load(ctx, s.id);
				const n = typeof x === "string" ? 0 : x.raw.split(/~\s*/).filter((t) => t.trim()).length;
				const rows = docRows(ctx);
				if (input.aid === pf(7)) {
					if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
					s.top = Math.max((s.top ?? 0) - rows, 0);
				} else if ((s.top ?? 0) + rows >= n) {
					s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				} else {
					s.top = Math.min((s.top ?? 0) + rows, n - rows);
				}
				return s;
			}
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
