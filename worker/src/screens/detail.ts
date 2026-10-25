import { createCustomer, deleteCustomer, getCustomer, updateCustomer } from "../data";
import { parseEditable, type Customer } from "../customer";
import { HttpError } from "../http";
import { newActivity } from "./activity";
import { newInvoices } from "./invoices";
import { dots, header, invalidKey, keys, label, lpad, message, money, newScreen, right, stamp, value, type Color, type Ctx, type Opts, type Screen } from "./screen";
import { fail, isCode, pf, setMsg, type DetailState, type Mode, type Next, type Program, type State } from "./program";

// Displays, updates, adds or deletes a single customer.

export function newAdd(back: State): DetailState {
	return { p: "detail", mode: "add", back, loaded: true, cust: { status: "A" } as Customer };
}

// newInquiry opens the inquiry screen, showing customer id if one is given.
export async function newInquiry(ctx: Ctx, back: State, id: string): Promise<DetailState> {
	const d: DetailState = { p: "detail", mode: "inquiry", back };
	return id ? loadDetail(ctx, d, id) : d;
}

// loadDetail reads a customer into d; d.loaded reports whether it was found.
export async function loadDetail(ctx: Ctx, d: DetailState, id: string): Promise<DetailState> {
	id = padID(id);
	d.vals = undefined;
	try {
		d.cust = await getCustomer(ctx.db, id);
		d.loaded = true;
	} catch (e) {
		d.loaded = false;
		d.cust = { id } as Customer;
		d.errField = "id";
		d.msg = isCode(e, "not_found") ? `CUS0201E CUSTOMER ${id} NOT FOUND` : fail(e);
	}
	return d;
}

export function padID(id: string): string {
	id = id.trim();
	return /^\d+$/.test(id) ? String(BigInt(id)).padStart(6, "0") : id;
}

interface FieldDef {
	name: string;
	label: string;
	length: number;
	numeric?: boolean;
	get: (c: Customer) => string;
}

const fields: FieldDef[] = [
	{ name: "name", label: "NAME", length: 30, get: (c) => c.name ?? "" },
	{ name: "addr", label: "ADDRESS", length: 30, get: (c) => c.address ?? "" },
	{ name: "city", label: "CITY", length: 18, get: (c) => c.city ?? "" },
	{ name: "state", label: "STATE", length: 2, get: (c) => c.state ?? "" },
	{ name: "zip", label: "ZIP CODE", length: 5, numeric: true, get: (c) => c.zip ?? "" },
	{ name: "phone", label: "PHONE", length: 12, get: (c) => c.phone ?? "" },
	{ name: "limit", label: "CREDIT LIMIT", length: 9, numeric: true,
		get: (c) => (!c.credit_limit && !c.id ? "" : String(c.credit_limit ?? 0)) },
	{ name: "status", label: "STATUS (A/H/C)", length: 1, get: (c) => c.status ?? "" },
];

const titles: Record<Mode, string> = {
	inquiry: "CUSTOMER INQUIRY",
	update: "CUSTOMER UPDATE",
	add: "ADD CUSTOMER",
	delete: "DELETE CUSTOMER",
};

const editable = (d: DetailState) => d.mode === "update" || d.mode === "add";

export const detail: Program<DetailState> = {
	async render(ctx, d) {
		const scr = newScreen(ctx, "CUSM02");
		header(scr, ctx, titles[d.mode]);
		const cust = d.cust ?? ({} as Customer);

		label(scr, 4, 4, "CUSTOMER NUMBER ===>");
		if (d.mode === "inquiry") {
			scr.input(4, 25, 6, "id", cust.id ?? "", { numeric: true, bright: d.errField === "id" });
		} else if (d.mode === "add") {
			scr.text(4, 25, "(ASSIGNED ON ADD)", { color: "blue" });
		} else {
			scr.text(4, 25, cust.id ?? "", { color: "white", bright: true });
		}

		if (d.loaded) {
			renderFields(scr, d, cust);
			renderAccount(ctx, scr, d, cust);
		}
		if (d.mode === "delete") {
			scr.text(19, 4, "*** PRESS PF10 TO CONFIRM DELETION, OR PF12 TO CANCEL ***", { color: "red", bright: true });
		}

		message(scr, d.msg ?? "");
		keys(scr, {
			inquiry: "PF1=HELP PF3=EXIT PF4=UPDATE PF5=EVENTS PF6=INVOICES PF9=DELETE PF12=CANCEL",
			update: "ENTER=SAVE  PF1=HELP  PF3=EXIT  PF12=CANCEL  CTRL+E=ERASE EOF",
			add: "ENTER=SAVE  PF1=HELP  PF3=EXIT  PF12=CANCEL  CTRL+E=ERASE EOF",
			delete: "PF1=HELP  PF3=EXIT  PF10=CONFIRM DELETE  PF12=CANCEL",
		}[d.mode]);

		if (d.errField) scr.cursorTo(d.errField);
		else if (editable(d)) scr.cursorTo("name");
		else if (d.mode === "inquiry") scr.cursorTo("id");
		else scr.setCursor(19, 4);
		return scr;
	},

	async handle(ctx, d, input) {
		d.msg = "";
		d.errField = undefined;
		switch (d.mode) {
			case "inquiry":
				return handleInquiry(ctx, d, input.aid, input.fields);
			case "update":
			case "add":
				return handleEdit(ctx, d, input.aid, input.fields, input.modified);
			default:
				return handleDelete(ctx, d, input.aid);
		}
	},
};

function renderFields(scr: Screen, d: DetailState, cust: Customer): void {
	fields.forEach((f, i) => {
		const row = 6 + i + (i >= 6 ? 1 : 0); // a blank line between address and account fields
		label(scr, row, 4, dots(f.label, 19));
		const v = d.vals ? (d.vals[f.name] ?? "") : f.get(cust);
		if (!editable(d)) {
			value(scr, row, 25, v);
			return;
		}
		const opts: Opts = { numeric: f.numeric, bright: d.errField === f.name };
		scr.input(row, 25, f.length, f.name, v, opts);
	});
}

function renderAccount(ctx: Ctx, scr: Screen, d: DetailState, c: Customer): void {
	if (d.mode === "add") return;
	const col = right(scr, 58);
	const limit = c.credit_limit ?? 0;
	const balance = c.balance ?? 0;
	label(scr, 6, col, "BALANCE");
	scr.text(6, col + 10, lpad(money(balance), 11), { color: "white" });
	label(scr, 7, col, "AVAILABLE");
	const avail = limit - balance;
	const color: Color = avail < Math.trunc(limit / 10) ? "red" : "green";
	scr.text(7, col + 10, lpad(money(avail), 11), { color });
	if (limit > 0) {
		const pct = Math.trunc((balance * 100) / limit);
		label(scr, 8, col, "UTILIZED");
		scr.text(8, col + 10, lpad(pct, 10) + "%", { color });
		const bar = Math.max(Math.min(Math.trunc((pct * 20) / 100), 20), 0);
		scr.text(9, col, "[" + "|".repeat(bar) + ".".repeat(20 - bar) + "]", { color });
	}
	const when = c.updated ? stamp(ctx, c.updated) : "";
	if (when) {
		label(scr, 16, 4, dots("LAST UPDATED", 19));
		value(scr, 16, 25, `${when} BY ${c.updated_by ?? ""}`);
	}
}

async function handleInquiry(ctx: Ctx, d: DetailState, aid: string, f: Record<string, string>): Promise<Next> {
	switch (aid) {
		case "ENTER": {
			const id = f.id ?? "";
			if (id.trim() === "") {
				Object.assign(d, { msg: "CUS0202E ENTER A CUSTOMER NUMBER", errField: "id", loaded: false, cust: undefined });
				return d;
			}
			await loadDetail(ctx, d, id);
			if (d.loaded) d.msg = `CUS0203I CUSTOMER ${d.cust!.id} DISPLAYED`;
			return d;
		}
		case pf(3):
		case pf(12):
			return d.back;
		case pf(4):
		case pf(9):
			if (!d.loaded) {
				d.msg = "CUS0204E DISPLAY A CUSTOMER FIRST";
				d.errField = "id";
				return d;
			}
			await loadDetail(ctx, d, d.cust!.id); // re-read for the latest copy
			if (d.loaded) d.mode = aid === pf(9) ? "delete" : "update";
			return d;
		case pf(5):
		case pf(6):
			if (!d.loaded) {
				d.msg = "CUS0204E DISPLAY A CUSTOMER FIRST";
				d.errField = "id";
				return d;
			}
			return aid === pf(5) ? newActivity(ctx, d, d.cust!.id) : newInvoices(d, d.cust!.id);
		case "CLEAR":
			return { p: "detail", mode: "inquiry", back: d.back };
	}
	d.msg = invalidKey(aid);
	return d;
}

// fieldMessageIDs gives each field's edit error its own message number.
const fieldMessageIDs: Record<string, string> = {
	name: "CUS0230E", city: "CUS0231E", state: "CUS0232E", zip: "CUS0233E",
	phone: "CUS0234E", limit: "CUS0235E", status: "CUS0236E", addr: "CUS0237E",
};

function fieldMessage(field: string, msg: string): string {
	return `${fieldMessageIDs[field] ?? "CUS0239E"} ${msg.toUpperCase()}`;
}

async function handleEdit(
	ctx: Ctx, d: DetailState, aid: string, f: Record<string, string>, modified: Set<string>,
): Promise<Next> {
	switch (aid) {
		case "ENTER":
			break;
		case pf(3):
			return d.back;
		case pf(12):
			if (d.mode === "add") return d.back;
			d.mode = "inquiry";
			d.vals = undefined;
			d.msg = "CUS0210I UPDATE CANCELLED, NO CHANGES MADE";
			return d;
		default:
			d.msg = invalidKey(aid);
			return d;
	}

	const vals: Record<string, string> = {};
	for (const fd of fields) vals[fd.name] = f[fd.name] ?? "";
	d.vals = vals;
	if (modified.size === 0 && d.mode === "update") {
		d.msg = "CUS0211W NO FIELDS WERE CHANGED";
		return d;
	}
	const limit = vals.limit.trim();
	if (!/^-?\d+$/.test(limit)) {
		d.errField = "limit";
		d.msg = fieldMessage("limit", "credit limit must be a whole, positive number");
		return d;
	}
	const id = d.cust?.id ?? "";
	try {
		const { fields: edit, version } = parseEditable({
			name: vals.name, address: vals.addr, city: vals.city, state: vals.state, zip: vals.zip,
			phone: vals.phone, credit_limit: Number(limit), status: vals.status, version: d.cust?.version ?? 0,
		});
		const saved = d.mode === "add"
			? await createCustomer(ctx.db, edit, ctx.user)
			: await updateCustomer(ctx.db, id, edit, version, ctx.user);
		const verb = d.mode === "add" ? "ADDED" : "UPDATED";
		Object.assign(d, { cust: saved, vals: undefined, mode: "inquiry", msg: `CUS0212I CUSTOMER ${saved.id} ${verb}` });
	} catch (e) {
		if (isCode(e, "invalid")) {
			d.errField = e.field;
			d.msg = fieldMessage(e.field ?? "", e.message);
		} else if (isCode(e, "conflict")) {
			await loadDetail(ctx, d, id);
			if (d.loaded) d.msg = `CUS0213E ${id} WAS CHANGED BY ANOTHER USER - REVIEW AND RESUBMIT`;
		} else if (isCode(e, "not_found")) {
			Object.assign(d, { mode: "inquiry", loaded: false, vals: undefined, errField: "id", msg: `CUS0214E CUSTOMER ${id} NO LONGER EXISTS` });
		} else {
			d.msg = fail(e);
		}
	}
	return d;
}

async function handleDelete(ctx: Ctx, d: DetailState, aid: string): Promise<Next> {
	const id = d.cust?.id ?? "";
	switch (aid) {
		case pf(10): {
			try {
				await deleteCustomer(ctx.db, id, ctx.user);
			} catch (e) {
				if (!(e instanceof HttpError && e.code === "not_found")) {
					d.msg = fail(e);
					return d;
				}
			}
			const msg = `CUS0220I CUSTOMER ${id} DELETED`;
			if (setMsg(d.back, msg)) return d.back;
			return { p: "detail", mode: "inquiry", back: d.back, msg };
		}
		case pf(3):
			return d.back;
		case pf(12):
			d.mode = "inquiry";
			d.msg = "CUS0221I DELETE CANCELLED";
			return d;
	}
	d.msg = invalidKey(aid);
	return d;
}
