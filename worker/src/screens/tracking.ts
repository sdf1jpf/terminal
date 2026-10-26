import { addressOf, cityLine } from "../invoices";
import { carriers, getShipment, shipStatusNames } from "../shipping";
import { confirmDelivery, deliveryNames, findShipment, getTracking, trackingEvents, type TrackingEvent } from "../tracking";
import { dots, header, invalidKey, keys, label, lpad, message, newScreen, pad, right, stamp, value, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type Program, type State, type TrackingState } from "./program";

// CUSS03 TRACKING is where a shipment is: the carrier's status, the date it
// promises, and every scan so far, newest first (tracking.ts). It finds a
// shipment by its number, its invoice or its tracking number. PF5 asks the
// carrier again; a company truck delivery is signed off by hand with PF10.

const rowsFor = (ctx: Ctx) => ctx.rows - 15;

const deliveryColor = (d: string): Color => (d === "D" ? "green" : d === "X" ? "red" : d === "O" ? "yellow" : "turquoise");

const codeColors: Record<string, Color> = { DELIVERED: "green", EXCEPTION: "red", OUTDLVY: "yellow", LABEL: "white" };

function scanLine(date: string, time: string, location: string, activity: string): string {
	return `${pad(date, 10)} ${pad(time, 5)} ${pad(location, 24)} ${activity}`;
}

export function newTracking(back: State, id = ""): TrackingState {
	return { p: "tracking", back, id: id.trim().toUpperCase() };
}

export const tracking: Program<TrackingState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSS03");
		header(scr, ctx, "SHIPMENT TRACKING");
		let msg = s.msg ?? "";
		// As typed with the option, such as TRACK 1Z...: show it by its number.
		if (s.id && s.errField !== "id" && !/^SHP\d{5}$/.test(s.id)) s.id = (await findShipment(ctx.db, s.id))?.id ?? s.id;
		label(scr, 4, 2, "SHIPMENT ===>");
		scr.input(4, 16, 20, "id", s.id ?? "", { bright: s.errField === "id" });
		scr.text(4, 38, "SHIPMENT, INVOICE OR TRACKING NUMBER", { color: "blue" });
		let legend = "PF1=HELP  PF3=EXIT  PF12=CANCEL";

		if (s.id && s.errField !== "id") {
			try {
				const { shipment: x, events } = await getTracking(ctx.db, ctx.tables, s.id);
				const { invoice: inv } = await getShipment(ctx.db, x.id);
				const col = right(scr, 46);
				label(scr, 6, 4, dots("CARRIER", 12));
				value(scr, 6, 18, carriers[x.carrier] ?? (x.carrier || "NOT CHOSEN YET"));
				label(scr, 6, col, "INVOICE");
				scr.text(6, col + 9, `${inv.id}  ${x.customer_id}`, { color: "white" });
				label(scr, 7, 4, dots("TRACKING", 12));
				value(scr, 7, 18, x.tracking || "(NONE YET)");
				label(scr, 7, col, "SHIPPED");
				scr.text(7, col + 9, x.shipped ? stamp(ctx, x.shipped).slice(0, 16) : "", { color: "white" });
				const to = addressOf(inv, "ship");
				label(scr, 8, 4, dots("SHIP TO", 12));
				value(scr, 8, 18, [to.name, cityLine(to)].filter(Boolean).join(", ").slice(0, scr.cols - 20));
				label(scr, 9, 4, dots("STATUS", 12));
				if (x.status !== "S") {
					scr.text(9, 18, `${shipStatusNames[x.status]} - NOT SHIPPED YET`, { color: "yellow", bright: true });
				} else {
					scr.text(9, 18, deliveryNames[x.delivery], { color: deliveryColor(x.delivery), bright: true });
					const when = x.delivery === "D"
						? `${stamp(ctx, x.delivered).slice(0, 16)}  SIGNED BY ${x.signed_by}`
						: x.eta ? `PROMISED ${x.eta}` : "";
					scr.text(9, 36, when, { color: x.delivery === "D" ? "green" : "white" });
					if (x.tracked) scr.text(10, 18, `CARRIER LAST ASKED ${stamp(ctx, x.tracked).slice(0, 16)}`, { color: "blue" });
				}
				const signable = x.status === "S" && x.carrier === "TRK" && x.delivery !== "D";
				if (signable) {
					label(scr, 11, 4, "TRUCK DELIVERED, SIGNED BY ===>");
					scr.input(11, 36, 20, "signed", s.signed ?? "", { bright: s.errField === "signed" });
					scr.text(11, 58, "THEN PF10", { color: "blue" });
				}

				const rows = rowsFor(ctx);
				const top = Math.min(s.top ?? 0, Math.max(events.length - rows, 0));
				scr.text(12, 2, scanLine("DATE", "TIME", "LOCATION", "ACTIVITY"), { color: "white", bright: true });
				if (events.length > rows) scr.text(12, right(scr, 66), `${top + 1}-${Math.min(top + rows, events.length)}/${events.length}`, { color: "white" });
				scr.text(13, 2, "-".repeat(scr.cols - 3), { color: "blue" });
				events.slice(top, top + rows).forEach((e: TrackingEvent, i) => {
					const [date, time] = stamp(ctx, e.at).split(" ");
					scr.text(14 + i, 2, scanLine(date ?? "", time ?? "", e.location, e.detail).slice(0, scr.cols - 3), { color: codeColors[e.code] ?? "turquoise" });
				});
				if (events.length === 0) {
					scr.text(14, 4, x.status === "S" ? "NO SCANS YET - PF5 ASKS THE CARRIER" : "TRACKING STARTS WHEN IT SHIPS", { color: "yellow" });
				}
				legend = signable
					? "PF1=HELP PF3=EXIT PF4=SHIPMENT PF5=ASK CARRIER PF6=TIMELINE PF7/8=SCROLL PF10=DELIVERED"
					: "PF1=HELP PF3=EXIT PF4=SHIPMENT PF5=ASK CARRIER PF6=TIMELINE PF7=UP PF8=DOWN";
				if (s.errField) scr.cursorTo(s.errField);
				else if (signable) scr.cursorTo("signed");
				else scr.cursorTo("id");
			} catch (e) {
				msg = isCode(e, "not_found") ? `CUS0803E SHIPMENT ${s.id} NOT FOUND` : fail(e);
				scr.cursorTo("id");
			}
		} else {
			scr.cursorTo("id");
		}
		message(scr, msg);
		keys(scr, legend);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		s.signed = (input.fields.signed ?? "").trim();
		const typed = (input.fields.id ?? "").trim().toUpperCase();
		if (input.aid === "ENTER" || (input.modified.has("id") && typed !== s.id)) {
			if (!typed) {
				s.id = "";
				s.msg = "CUS0820E ENTER A SHIPMENT, INVOICE OR TRACKING NUMBER";
				s.errField = "id";
				return s;
			}
			if (typed !== s.id) {
				const shp = await findShipment(ctx.db, typed);
				if (!shp) {
					s.id = typed;
					s.msg = `CUS0821E NO SHIPMENT FOR ${typed}`;
					s.errField = "id";
					return s;
				}
				s.id = shp.id;
				s.top = 0;
				s.signed = "";
			}
			if (input.aid === "ENTER") return s;
		}
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				if (!s.id) break;
				if (s.back.p === "shipment" && s.back.id === s.id) return s.back;
				return { p: "shipment", back: s, id: s.id };
			case pf(5):
				if (!s.id) break;
				try {
					const { shipment: x } = await getTracking(ctx.db, ctx.tables, s.id, true);
					s.msg = x.status === "S"
						? `CUS0822I ${x.carrier} SAYS ${x.id} IS ${deliveryNames[x.delivery]}`
						: `CUS0823W ${x.id} HAS NOT SHIPPED`;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
			case pf(6): {
				if (!s.id) break;
				const shp = await findShipment(ctx.db, s.id);
				if (!shp) break;
				if (s.back.p === "timeline" && s.back.id === shp.invoice_id) return s.back;
				return { p: "timeline", back: s, id: shp.invoice_id };
			}
			case pf(7):
			case pf(8): {
				if (!s.id) break;
				const total = (await trackingEvents(ctx.db, s.id)).length;
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
			case pf(10):
				if (!s.id) break;
				try {
					const x = await confirmDelivery(ctx.db, ctx.user, s.id, s.signed ?? "");
					s.signed = undefined;
					s.top = 0;
					s.msg = `CUS0824I ${x.id} DELIVERED, SIGNED BY ${x.signed_by}`;
				} catch (e) {
					if (isCode(e, "invalid")) {
						s.errField = e.field === "signed" ? "signed" : undefined;
						s.msg = `CUS0825E ${e.message.toUpperCase()}`;
					} else if (isCode(e, "conflict")) {
						s.msg = `CUS0809E SHIPMENT ${s.id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
					} else {
						s.msg = fail(e);
					}
				}
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
