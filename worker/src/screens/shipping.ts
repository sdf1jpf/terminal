import { bill } from "../edi";
import { submitJob } from "../jobs";
import type { Customer } from "../customer";
import { getCustomer } from "../data";
import type { Invoice, InvoiceLine } from "../invoices";
import { binFor, cancelShipment, carriers, getShipment, listShipments, pack, ship, shipStatusNames, type Shipment } from "../shipping";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, pad, right, stamp, value, type Color, type Ctx } from "./screen";
import { fail, isCode, pf, type Next, type Program, type ShipmentState, type ShipmentsState, type State } from "./program";

// CUSS01 SHIPPING lists shipments, newest first, and prints pick tickets
// (the CUSPICK job). CUSS02 SHIPMENT is the warehouse's view of one: its
// pick ticket in bin order, then packing (cartons and weight) and shipping
// (carrier), and billing the invoice once it has gone.

const statusColor = (status: string): Color => (status === "P" ? "white" : status === "K" ? "yellow" : "green");

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(id: string, inv: string, cust: string, status: string, ctn: string, carrier: string, tracking: string, at: string): string {
	return `${pad(id, 8)} ${pad(inv, 8)} ${pad(cust, 7)} ${pad(status, 8)} ${lpad(ctn, 4)} ${pad(carrier, 4)} ${pad(tracking, 18)} ${at}`;
}

function scroll(s: { top?: number; msg?: string }, aid: string, rows: number, total: number): void {
	if (aid === pf(7)) {
		if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
		s.top = Math.max((s.top ?? 0) - rows, 0);
	} else if ((s.top ?? 0) + rows >= total) {
		s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
	} else {
		s.top = Math.min((s.top ?? 0) + rows, total - rows);
	}
}

export function newShipments(back: State, status = ""): ShipmentsState {
	const st = status.trim().toUpperCase();
	return { p: "shipments", back, status: shipStatusNames[st] ? st : "" };
}

export const shipments: Program<ShipmentsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSS01");
		header(scr, ctx, "SHIPPING");
		let msg = s.msg ?? "";
		let list: Shipment[] = [];
		try {
			list = await listShipments(ctx.db, s.status ?? "");
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));

		label(scr, 4, 2, "STATUS ===>");
		scr.input(4, 14, 1, "status", s.status ?? "", { bright: s.errField === "status" });
		scr.text(4, 17, "P=PICKING  K=PACKED  S=SHIPPED  BLANK=ALL", { color: "blue" });
		if (list.length > 0) {
			scr.text(5, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, "SELECT: S=SHOW", { color: "blue" });
		scr.text(7, 2, "S " + listLine("SHIPMENT", "INVOICE", "CUST NO", "STATUS", "CTN", "VIA", "TRACKING", "RELEASED"), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((x, i) => {
			scr.input(9 + i, 2, 1, "sel:" + x.id, "", { bright: s.errSel === x.id });
			scr.text(9 + i, 4, listLine(x.id, x.invoice_id, x.customer_id, shipStatusNames[x.status], x.cartons ? String(x.cartons) : "",
				x.carrier, x.tracking, stamp(ctx, x.created).slice(0, 10)), { color: statusColor(x.status) });
		});
		if (list.length === 0) scr.text(9, 4, "NO SHIPMENTS - PF6 ON AN OPEN INVOICE RELEASES IT TO THE WAREHOUSE", { color: "yellow" });

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF6=PICK TICKETS  PF7=UP  PF8=DOWN  PF12=CANCEL");
		if (s.errField) scr.cursorTo(s.errField);
		else if (s.errSel && shown.some((x) => x.id === s.errSel)) scr.cursorTo("sel:" + s.errSel);
		else if (shown.length > 0) scr.cursorTo("sel:" + shown[0].id);
		else scr.cursorTo("status");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = s.errField = undefined;
		const st = (input.fields.status ?? "").trim().toUpperCase();
		if (input.aid === "ENTER" && input.modified.has("status") && st !== (s.status ?? "")) {
			if (st && !shipStatusNames[st]) {
				s.msg = "CUS0801E STATUS MUST BE P, K, S OR BLANK";
				s.errField = "status";
				return s;
			}
			s.status = st;
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
					return { p: "shipment", back: s, id };
				}
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				s.msg = "CUS0802I SHIPPING LIST REFRESHED";
				return s;
			case pf(6):
				try {
					const job = await submitJob(ctx.db, ctx.jobs, ctx.user, "CUSPICK");
					s.msg = `$HASP100 CUSPICK ON INTRDR - ${job.id} SUBMITTED - OUTPUT ON OPTION 5.1`;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, listRows(ctx), (await listShipments(ctx.db, s.status ?? "")).length);
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// ---- CUSS02 SHIPMENT ----

const lineRows = (ctx: Ctx) => ctx.rows - 15;

const messageIDs: Record<string, string> = { cartons: "CUS0810E", weight: "CUS0811E", carrier: "CUS0812E", status: "CUS0813E" };
const fieldMessage = (field: string, msg: string) => `${messageIDs[field] ?? "CUS0819E"} ${msg.toUpperCase()}`;

type Loaded = { shipment: Shipment; invoice: Invoice; lines: InvoiceLine[]; cust?: Customer };

async function load(ctx: Ctx, id: string): Promise<Loaded | string> {
	try {
		const got: Loaded = await getShipment(ctx.db, id);
		got.cust = await getCustomer(ctx.db, got.shipment.customer_id).catch(() => undefined);
		return got;
	} catch (e) {
		return isCode(e, "not_found") ? `CUS0803E SHIPMENT ${id} NOT FOUND` : fail(e);
	}
}

export const shipment: Program<ShipmentState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSS02");
		header(scr, ctx, "SHIPMENT");
		const got = await load(ctx, s.id);
		let msg = s.msg ?? "";
		let legend = "PF1=HELP  PF3=EXIT  PF12=CANCEL";
		if (typeof got === "string") {
			msg = got;
		} else {
			const { shipment: x, invoice: inv, lines, cust } = got;
			const col = right(scr, 52);
			label(scr, 4, 4, dots("SHIPMENT", 12));
			scr.text(4, 18, x.id, { color: "white", bright: true });
			scr.text(4, 28, shipStatusNames[x.status], { color: statusColor(x.status), bright: true });
			label(scr, 4, col, "INVOICE");
			scr.text(4, col + 8, `${inv.id} ${money(inv.total)}`, { color: "white" });
			label(scr, 5, 4, dots("SHIP TO", 12));
			value(scr, 5, 18, `${x.customer_id} ${cust?.name ?? "(NOT ON FILE)"}`);
			label(scr, 5, col, "PO");
			scr.text(5, col + 8, inv.po_number || "(NONE)", { color: "white" });
			if (cust) value(scr, 6, 18, `${cust.address}  ${cust.city}, ${cust.state} ${cust.zip}`.slice(0, scr.cols - 20));
			const when = [`RELEASED ${stamp(ctx, x.created)}`];
			if (x.packed) when.push(`PACKED ${stamp(ctx, x.packed).slice(11)}`);
			if (x.shipped) when.push(`SHIPPED ${stamp(ctx, x.shipped).slice(11)}`);
			scr.text(7, 18, when.join("  "), { color: "green" });

			if (x.status === "P") {
				label(scr, 9, 4, "PACK:  CARTONS ===>");
				scr.input(9, 24, 3, "cartons", s.vals?.cartons ?? "", { numeric: true, bright: s.errField === "cartons" });
				label(scr, 9, 30, "WEIGHT (LB) ===>");
				scr.input(9, 47, 5, "weight", s.vals?.weight ?? "", { numeric: true, bright: s.errField === "weight" });
				scr.text(9, 54, "THEN PF10", { color: "blue" });
				legend = "PF1=HELP PF3=EXIT PF4=INVOICE PF7/8=SCROLL PF9=CANCEL SHIP PF10=PACK";
			} else if (x.status === "K") {
				value(scr, 8, 4, `PACKED ${x.cartons} CARTONS, ${x.weight} LB`);
				label(scr, 9, 4, "SHIP:  CARRIER ===>");
				scr.input(9, 24, 3, "carrier", s.vals?.carrier ?? "", { bright: s.errField === "carrier" });
				scr.text(9, 30, Object.entries(carriers).map(([k, v]) => `${k}=${v}`).join("  "), { color: "blue" });
				legend = "PF1=HELP PF3=EXIT PF4=INVOICE PF7/8=SCROLL PF9=CANCEL SHIP PF10=SHIP";
			} else {
				value(scr, 8, 4, `${x.cartons} CARTONS, ${x.weight} LB`);
				scr.text(9, 4, `SHIPPED VIA ${carriers[x.carrier] ?? x.carrier}  TRACKING ${x.tracking}`, { color: "green", bright: true });
				legend = inv.status === "O"
					? "PF1=HELP  PF3=EXIT  PF4=INVOICE  PF7/8=SCROLL  PF11=BILL INVOICE  PF12=CANCEL"
					: "PF1=HELP  PF3=EXIT  PF4=INVOICE  PF7=UP  PF8=DOWN  PF12=CANCEL";
			}

			const rows = lineRows(ctx);
			const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));
			scr.text(11, 4, `${pad("BIN", 7)} ${lpad("LN", 3)} ${pad("SKU", 10)} ${pad("DESCRIPTION", 30)}    QTY`, { color: "white", bright: true });
			if (lines.length > rows) scr.text(11, right(scr, 66), `${top + 1}-${Math.min(top + rows, lines.length)}/${lines.length}`, { color: "white" });
			scr.text(12, 4, "-".repeat(scr.cols - 6), { color: "blue" });
			const byBin = lines.map((l) => ({ ...l, bin: binFor(l.sku) })).sort((a, b) => a.bin.localeCompare(b.bin) || a.line - b.line);
			byBin.slice(top, top + rows).forEach((l, i) => {
				scr.text(13 + i, 4, `${pad(l.bin, 7)} ${lpad(l.line, 3)} ${pad(l.sku, 10)} ${pad(l.description, 30)} ${lpad(l.quantity, 6)}`,
					{ color: statusColor(x.status) });
			});
			if (s.errField) scr.cursorTo(s.errField);
			else if (x.status === "P") scr.cursorTo("cartons");
			else if (x.status === "K") scr.cursorTo("carrier");
		}
		message(scr, msg);
		keys(scr, legend);
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errField = s.confirm = undefined;
		const f = input.fields;
		s.vals = { cartons: (f.cartons ?? "").trim(), weight: (f.weight ?? "").trim(), carrier: (f.carrier ?? "").trim().toUpperCase() };
		const got = await load(ctx, s.id);
		const status = typeof got === "string" ? "" : got.shipment.status;
		switch (input.aid) {
			case "ENTER":
				if (status === "P" || status === "K") s.msg = `CUS0804I PRESS PF10 TO ${status === "P" ? "PACK" : "SHIP"} ${s.id}`;
				return s;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(4):
				if (typeof got === "string") break;
				// Back to the invoice this came from, rather than another copy.
				if (s.back.p === "invoice" && s.back.id === got.invoice.id) return s.back;
				return { p: "invoice", back: s, id: got.invoice.id };
				break;
			case pf(7):
			case pf(8):
				scroll(s, input.aid, lineRows(ctx), typeof got === "string" ? 0 : got.lines.length);
				return s;
			case pf(9):
				if (status !== "P" && status !== "K") break;
				if (!confirm) {
					s.confirm = true;
					s.msg = `CUS0805W PRESS PF9 AGAIN TO CANCEL ${s.id} AND REOPEN THE INVOICE`;
					return s;
				}
				return act(s, async () => {
					await cancelShipment(ctx.db, s.id);
					if (s.back.p === "shipments") s.back.msg = `CUS0806I SHIPMENT ${s.id} CANCELLED - THE INVOICE CAN BE CHANGED AGAIN`;
					return s.back;
				});
			case pf(10):
				if (status === "P") {
					const n = (k: "cartons" | "weight") => (/^\d+$/.test(s.vals![k]) ? Number(s.vals![k]) : NaN);
					return act(s, async () => {
						const x = await pack(ctx.db, s.id, n("cartons"), n("weight"));
						s.vals = undefined;
						s.msg = `CUS0807I ${s.id} PACKED: ${x.cartons} CARTONS, ${x.weight} LB - ENTER A CARRIER AND PRESS PF10 TO SHIP`;
						return s;
					});
				}
				if (status === "K") {
					return act(s, async () => {
						const { shipment: x, edi } = await ship(ctx.db, ctx.user, s.id, s.vals!.carrier);
						s.vals = undefined;
						s.msg = `CUS0808I ${s.id} SHIPPED VIA ${x.carrier} ${x.tracking}${edi ? ` - 856 ${edi.id} SENT` : ""} - PF11 BILLS IT`;
						return s;
					});
				}
				break;
			case pf(11):
				if (status !== "S" || typeof got === "string" || got.invoice.status !== "O") break;
				return act(s, async () => {
					const { invoice: inv, edi } = await bill(ctx.db, ctx.user, got.invoice.id);
					s.msg = `CUS0507I INVOICE ${inv.id} BILLED, ${money(inv.total)} POSTED TO ${inv.customer_id}${edi ? ` - 810 ${edi.id} SENT` : ""}`;
					return s;
				});
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

async function act(s: ShipmentState, fn: () => Promise<Next>): Promise<Next> {
	try {
		return await fn();
	} catch (e) {
		if (isCode(e, "invalid")) {
			s.errField = e.field === "status" || e.field === "sku" ? undefined : e.field;
			s.msg = fieldMessage(e.field ?? "", e.message);
		} else if (isCode(e, "conflict")) {
			s.msg = `CUS0809E SHIPMENT ${s.id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
		} else {
			s.msg = fail(e);
		}
		return s;
	}
}
