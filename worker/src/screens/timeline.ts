import { getFlow, flowStatusNames, pendingSignals, timeline, workflowStatus, type OrderKind, type TimelineEvent } from "../lifecycle";
import { header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, type Color, type Ctx } from "./screen";
import { fail, pf, type Program, type State, type TimelineState } from "./program";

// CUSL01 ORDER TIMELINE is an order's life as its lifecycle workflow saw
// it (lifecycle.ts), oldest first: opened, released, packed, shipped,
// billed, each EDI document, each dunning letter, paid. Above it, where the
// lifecycle is and what it waits for next. PF4 opens the invoice or
// purchase order.

const rowsFor = (ctx: Ctx) => ctx.rows - 14;

function eventLine(n: string, date: string, time: string, event: string, detail: string, amount: string, user: string): string {
	return `${lpad(n, 3)} ${pad(date, 10)} ${pad(time, 5)} ${pad(event, 13)} ${pad(detail, 31)} ${lpad(amount, 9)} ${pad(user, 8)}`;
}

const colors: Record<string, Color> = {
	OPENED: "white", RELEASED: "turquoise", UNRELEASED: "yellow", PACKED: "turquoise", SHIPPED: "green", "OUT FOR DLVY": "turquoise", DELIVERED: "green", EXCEPTION: "red", BILLED: "white",
	PAID: "green", CANCELLED: "pink", SENT: "turquoise", CONFIRMED: "turquoise", "IN TRANSIT": "turquoise",
	RECEIPT: "green", RECEIVED: "green", EXPEDITE: "red", "EDI HELD": "yellow", CORRECTED: "green", DROPPED: "yellow", REMINDER: "yellow", "SECOND NOTICE": "yellow", "FINAL NOTICE": "red", "ON HOLD": "red",
};

// orderRef reads a typed order number: an invoice, INV00042 or just 42,
// or a purchase order, PO00012 or PO12.
export function orderRef(typed: string): { kind: OrderKind; ref: string } {
	const v = typed.trim().toUpperCase();
	if (/^(INV)?\d{1,5}$/.test(v)) return { kind: "I", ref: "INV" + v.replace(/^INV/, "").padStart(5, "0") };
	if (/^PO\d{1,5}$/.test(v)) return { kind: "P", ref: "PO" + v.slice(2).padStart(5, "0") };
	return { kind: "I", ref: v };
}

export function newTimeline(back: State, id = ""): TimelineState {
	return { p: "timeline", back, id: id.trim() ? orderRef(id).ref : "" };
}

async function events(ctx: Ctx, s: TimelineState): Promise<TimelineEvent[]> {
	return s.id ? timeline(ctx.db, orderRef(s.id).kind, s.id) : [];
}

export const timelinePanel: Program<TimelineState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSL01");
		header(scr, ctx, "ORDER TIMELINE");
		let msg = s.msg ?? "";
		label(scr, 4, 2, "ORDER NUMBER =====>");
		scr.input(4, 22, 8, "id", s.id ?? "", { bright: s.errField === "id" });
		scr.text(4, 32, "INVOICE (INV42 OR 42) OR PO (PO12)", { color: "blue" });

		let list: TimelineEvent[] = [];
		if (s.id) {
			const { kind } = orderRef(s.id);
			try {
				const [flow, wf, pending] = await Promise.all([
					getFlow(ctx.db, kind, s.id), workflowStatus(ctx.env, kind, s.id), pendingSignals(ctx.db, kind, s.id),
				]);
				list = await events(ctx, s);
				label(scr, 5, 2, "LIFECYCLE .........");
				if (flow) {
					const status = flowStatusNames[flow.status];
					scr.text(5, 22, pad(flow.outcome ? `${status} - ${flow.outcome}` : status, 22), {
						color: flow.status === "C" ? "green" : "turquoise", bright: true,
					});
					scr.text(5, 45, `STARTED ${stamp(ctx, flow.started).slice(0, 16)}`, { color: "green" });
					if (wf) scr.text(5, right(scr, 72), lpad(`WF ${wf.toUpperCase()}`, 8).slice(0, 8), { color: wf === "errored" ? "red" : "blue" });
					if (flow.status !== "C") {
						label(scr, 6, 2, "WAITING FOR .......");
						scr.text(6, 22, pad(flow.next, 40), { color: "yellow", bright: true });
						if (flow.next_at) scr.text(6, right(scr, 64), `BY ${stamp(ctx, flow.next_at).slice(0, 10)}`, { color: "yellow" });
					}
				} else {
					scr.text(5, 22, pending ? "STARTING" : "NONE", { color: "yellow" });
				}
				if (pending) {
					scr.text(7, 2, `${pending} CHANGE${pending === 1 ? "" : "S"} NOT YET SEEN BY THE LIFECYCLE - IT LOOKS EVERY MINUTE`, { color: "blue" });
				}
				if (!flow && list.length === 0 && !pending && !msg) msg = `CUS1610W ${s.id} HAS NO LIFECYCLE`;
			} catch (e) {
				msg = fail(e);
			}
		}

		const rows = rowsFor(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		if (list.length > rows) {
			scr.text(8, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(9, 2, eventLine("NO.", "DATE", "TIME", "EVENT", "DETAIL", "AMOUNT", "USER"), { color: "white", bright: true });
		scr.text(10, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.slice(top, top + rows).forEach((e, i) => {
			const [date, time] = stamp(ctx, e.at).split(" ");
			scr.text(11 + i, 2, eventLine(String(top + i + 1), date ?? "", time ?? "", e.event, e.detail,
				e.amount === null ? "" : money(e.amount), e.by), { color: colors[e.event] ?? (e.event.startsWith("EDI") ? "blue" : "green") });
		});

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF4=ORDER  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		scr.cursorTo("id");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		switch (input.aid) {
			case "ENTER": {
				const typed = (input.fields.id ?? "").trim();
				s.id = typed ? orderRef(typed).ref : "";
				s.top = 0;
				if (!s.id) {
					s.msg = "CUS1611E ENTER AN ORDER NUMBER";
					s.errField = "id";
				}
				return s;
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4): {
				if (!s.id) break;
				const isPO = orderRef(s.id).kind === "P";
				if ((s.back.p === "invoice" || s.back.p === "po") && s.back.id === s.id) return s.back;
				const found = await ctx.db.prepare(`SELECT 1 FROM ${isPO ? "purchase_orders" : "invoices"} WHERE id = ?`).bind(s.id).first();
				if (found) return isPO ? { p: "po", back: s, id: s.id } : { p: "invoice", back: s, id: s.id };
				s.msg = isPO ? `CUS0702E PURCHASE ORDER ${s.id} NOT FOUND` : `CUS0504E INVOICE ${s.id} NOT FOUND`;
				return s;
			}
			case pf(5):
				return s;
			case pf(7):
			case pf(8): {
				const total = (await events(ctx, s)).length;
				const rows = rowsFor(ctx);
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
