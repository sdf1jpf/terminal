import { correctException, dropException, listExceptions, rejectOrder, type EdiException } from "../ediexceptions";
import { newSkuSearch } from "./skusearch";
import { header, invalidKey, keys, lpad, message, newScreen, pad, right, type Ctx } from "./screen";
import { fail, isCode, pf, type EdiExState, type Next, type Program, type State } from "./program";

// CUSE03 EDI EXCEPTIONS lists the lines of customers' 850s held because
// their product is missing, not on file or discontinued (ediexceptions.ts),
// oldest first. Typing a SKU under NEW SKU and pressing Enter puts that
// product on the invoice for the quantity ordered. F finds a product (the
// CUSI03 search), D drops the line, and R, entered twice, rejects the whole
// order and cancels its invoice. Once an invoice has no held lines it can
// go to the warehouse, and its lifecycle carries on.

const listRows = (ctx: Ctx) => ctx.rows - 11;

function listLine(inv: string, cust: string, po: string, ln: string, sku: string, qty: string, problem: string): string {
	return `${pad(inv, 8)} ${pad(cust, 6)} ${pad(po, 12)} ${lpad(ln, 3)} ${pad(sku, 10)} ${lpad(qty, 5)} ${pad(problem, 15)}`;
}

const shortProblem = (p: string) => p.replace(/^PRODUCT /, "").replace("NO VP OR BP PRODUCT ID", "NO PRODUCT ID");

export function newEdiEx(back: State): EdiExState {
	return { p: "ediex", back };
}

export const ediex: Program<EdiExState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSE03");
		header(scr, ctx, "EDI EXCEPTIONS");
		let msg = s.msg ?? "";
		let list: EdiException[] = [];
		try {
			list = await listExceptions(ctx.db);
		} catch (e) {
			msg = fail(e);
		}
		const rows = listRows(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		const orders = new Set(list.map((x) => x.invoice_id)).size;
		scr.text(4, 2, list.length === 0 ? "NO EDI LINES ARE HELD"
			: `${list.length} 850 LINE${list.length === 1 ? "" : "S"} HELD ON ${orders} ORDER${orders === 1 ? "" : "S"}`,
		{ color: list.length ? "yellow" : "green", bright: true });
		if (list.length > rows) {
			scr.text(4, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		}
		scr.text(5, 2, "SELECT: F=FIND PRODUCT  D=DROP LINE  R=REJECT ORDER    OR TYPE A NEW SKU", { color: "blue" });
		scr.text(7, 2, "S " + listLine("INVOICE", "CUST", "PO NUMBER", "LN", "SKU SENT", "QTY", "PROBLEM") + " NEW SKU", { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((x, i) => {
			scr.input(9 + i, 2, 1, `sel:${x.seq}`, "", { bright: s.errSel === String(x.seq) });
			scr.text(9 + i, 4, listLine(x.invoice_id, x.customer_id, x.po_number, x.po_line, x.sku || "(NONE)", String(x.quantity), shortProblem(x.problem)),
				{ color: s.confirm === x.seq ? "red" : "yellow" });
			scr.input(9 + i, 70, 10, `sku:${x.seq}`, s.vals?.[`sku:${x.seq}`] ?? "", { bright: s.errSel === String(x.seq) });
		});

		message(scr, msg);
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF12=CANCEL");
		const err = shown.find((x) => String(x.seq) === s.errSel);
		if (err) scr.cursorTo(`sku:${err.seq}`);
		else if (shown.length > 0) scr.cursorTo(`sku:${shown[0].seq}`);
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errSel = s.confirm = undefined;
		switch (input.aid) {
			case "ENTER":
				return apply(ctx, s, input.fields, confirm);
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				return s;
			case pf(7):
			case pf(8): {
				const rows = listRows(ctx);
				const total = (await listExceptions(ctx.db)).length;
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

// apply acts on the first line with a selection code, or else the first
// with a new SKU.
async function apply(ctx: Ctx, s: EdiExState, fields: Record<string, string>, confirm?: number): Promise<Next> {
	const vals: Record<string, string> = {};
	for (const [name, v] of Object.entries(fields)) if (name.startsWith("sku:") && v.trim()) vals[name] = v.trim().toUpperCase();
	s.vals = vals;
	const act = async (seq: number, fn: () => Promise<string>): Promise<Next> => {
		try {
			s.msg = await fn();
			delete vals[`sku:${seq}`];
		} catch (e) {
			s.errSel = String(seq);
			s.msg = isCode(e, "invalid") || isCode(e, "not_found") ? `CUS0545E ${(e as Error).message.toUpperCase()}` : fail(e);
		}
		return s;
	};
	for (const [name, v] of Object.entries(fields)) {
		const code = v.trim().toUpperCase();
		if (!name.startsWith("sel:") || code === "") continue;
		const seq = Number(name.slice(4));
		const x = (await listExceptions(ctx.db)).find((e) => e.seq === seq);
		if (!x) {
			s.msg = "CUS0546E THAT LINE IS NO LONGER HELD";
			return s;
		}
		if (code === "F") return newSkuSearch(s, vals[`sku:${seq}`] ?? x.sku, undefined, seq);
		if (code === "D") {
			return act(seq, async () => {
				await dropException(ctx.db, ctx.user, seq);
				return `CUS0542I PO1 LINE ${x.po_line} DROPPED FROM ${x.invoice_id}`;
			});
		}
		if (code === "R") {
			if (confirm !== seq) {
				s.confirm = seq;
				s.errSel = String(seq);
				s.msg = `CUS0547W ENTER R AGAIN TO REJECT PO ${x.po_number} FROM ${x.customer_id} AND CANCEL ${x.invoice_id}`;
				return s;
			}
			return act(seq, async () => {
				await rejectOrder(ctx.db, ctx.user, seq);
				return `CUS0543I PO ${x.po_number} REJECTED, ${x.invoice_id} CANCELLED`;
			});
		}
		s.errSel = String(seq);
		s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
		return s;
	}
	for (const [name, sku] of Object.entries(vals)) {
		const seq = Number(name.slice(4));
		return act(seq, async () => {
			const { exception: x, line } = await correctException(ctx.db, ctx.user, seq, sku);
			return `CUS0541I ${sku} ADDED TO ${x.invoice_id} AS LINE ${line.line} FOR PO1 LINE ${x.po_line}`;
		});
	}
	return s;
}
