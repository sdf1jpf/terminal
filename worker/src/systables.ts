// System tables: small reference tables the operators maintain, kept in
// Workers KV (the TABLES binding) so that every request can read them
// fast, from the edge cache. They play the part of a mainframe shop's
// table files: carrier rates and routing, sales tax codes, and screen help
// text.
//
// Each table is one KV value, a JSON object of rows by key, read with a
// short cache TTL. A table that was never changed is not in KV at all and
// reads as its defaults, below; the first change stores the whole table.
// Changes read, modify and write the whole table, so two operators saving
// the same table at the same moment can lose one change (KV has no
// transactions). That is fine for tables changed by hand a few times a
// year; anything busier belongs in D1.

import { HttpError } from "./http";
import { syslog } from "./syslog";

export type Kind = "text" | "int" | "decimal" | "lines";

export interface Column {
	name: string;
	label: string; // on the screen
	kind: Kind;
	len: number; // the input field's length; "lines" fields are that wide
	lines?: number; // "lines" only: how many
	min?: number;
	max?: number;
	pattern?: RegExp; // text only, upper-cased first
	hint?: string; // why the pattern failed
}

export type Row = Record<string, string | number | string[]>;

export interface Table {
	title: string;
	desc: string;
	key: { label: string; len: number; pattern: RegExp; hint: string };
	columns: Column[];
	defaults: Record<string, Row>;
}

const usStates = /^[A-Z]{2}$/;

// The carrier routing guide: carriers are tried by priority and the first
// whose limits all hold wins. A limit of 0 is no limit. The defaults give
// the shipping desk's rules: the company truck in its area, UPS for small
// orders, FedEx Freight for the rest.
const carrier: Table = {
	title: "CARRIER RATES AND ROUTING",
	desc: "Carriers, their rates and the orders they take",
	key: { label: "CARRIER", len: 3, pattern: /^[A-Z0-9]{2,3}$/, hint: "2 or 3 letters or digits" },
	columns: [
		{ name: "name", label: "NAME", kind: "text", len: 20, pattern: /^.+$/, hint: "required" },
		{ name: "priority", label: "PRIORITY", kind: "int", len: 3, min: 1, max: 999 },
		{ name: "service_states", label: "SERVICE STATES", kind: "text", len: 60, pattern: /^([A-Z]{2}( [A-Z]{2})*)?$/, hint: "state codes separated by blanks, or blank for anywhere" },
		{ name: "min_weight_lb", label: "MIN WEIGHT LB", kind: "int", len: 6, min: 0, max: 999999 },
		{ name: "max_weight_lb", label: "MAX WEIGHT LB", kind: "int", len: 6, min: 0, max: 999999 },
		{ name: "max_carton_lb", label: "MAX CARTON LB", kind: "int", len: 6, min: 0, max: 999999 },
		{ name: "min_value", label: "MIN ORDER $", kind: "int", len: 9, min: 0, max: 999999999 },
		{ name: "max_value", label: "MAX ORDER $", kind: "int", len: 9, min: 0, max: 999999999 },
		{ name: "base_charge", label: "BASE CHARGE $", kind: "decimal", len: 9, min: 0, max: 99999 },
		{ name: "per_lb", label: "PER LB $", kind: "decimal", len: 7, min: 0, max: 999 },
		{ name: "transit_days", label: "TRANSIT DAYS", kind: "int", len: 2, min: 0, max: 99 },
	],
	defaults: {
		TRK: {
			name: "COMPANY TRUCK", priority: 1, service_states: "OH IN KY MI PA WV", min_weight_lb: 0, max_weight_lb: 0,
			max_carton_lb: 0, min_value: 0, max_value: 0, base_charge: 45, per_lb: 0.1, transit_days: 2,
		},
		UPS: {
			name: "UPS GROUND", priority: 2, service_states: "", min_weight_lb: 0, max_weight_lb: 149,
			max_carton_lb: 70, min_value: 0, max_value: 4999, base_charge: 12.5, per_lb: 0.85, transit_days: 4,
		},
		FDX: {
			name: "FEDEX FREIGHT", priority: 3, service_states: "", min_weight_lb: 0, max_weight_lb: 0,
			max_carton_lb: 0, min_value: 0, max_value: 0, base_charge: 95, per_lb: 0.42, transit_days: 3,
		},
	},
};

// Sales tax by ship-to state. A state that is not listed charges none.
const taxcode: Table = {
	title: "SALES TAX CODES",
	desc: "Sales tax rate by state",
	key: { label: "STATE", len: 2, pattern: usStates, hint: "a 2-letter state code" },
	columns: [
		{ name: "desc", label: "DESCRIPTION", kind: "text", len: 30, pattern: /^.+$/, hint: "required" },
		{ name: "rate", label: "RATE %", kind: "decimal", len: 6, min: 0, max: 25 },
		{ name: "freight", label: "TAX FREIGHT", kind: "text", len: 1, pattern: /^[YN]$/, hint: "Y or N" },
	],
	defaults: {
		IL: { desc: "ILLINOIS", rate: 6.25, freight: "N" },
		IN: { desc: "INDIANA", rate: 7, freight: "N" },
		KY: { desc: "KENTUCKY", rate: 6, freight: "Y" },
		MI: { desc: "MICHIGAN", rate: 6, freight: "Y" },
		NY: { desc: "NEW YORK", rate: 4, freight: "Y" },
		OH: { desc: "OHIO", rate: 5.75, freight: "Y" },
		PA: { desc: "PENNSYLVANIA", rate: 6, freight: "Y" },
		TX: { desc: "TEXAS", rate: 6.25, freight: "Y" },
		WV: { desc: "WEST VIRGINIA", rate: 6, freight: "Y" },
	},
};

// Screen help text. A row here replaces the built-in PF1 help for a field,
// or adds help where there is none. The key is "panel.field" (browse.filter)
// or a field name for every panel (status).
const helptext: Table = {
	title: "SCREEN HELP TEXT",
	desc: "PF1 field help, replacing or adding to the built-in text",
	key: { label: "PANEL.FIELD", len: 24, pattern: /^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)?$/, hint: 'a field name, or panel.field such as BROWSE.FILTER' },
	columns: [
		{ name: "title", label: "TITLE", kind: "text", len: 40, pattern: /^.+$/, hint: "required" },
		{ name: "text", label: "TEXT", kind: "lines", len: 72, lines: 10 },
	],
	defaults: {},
};

export const tables: Record<string, Table> = { CARRIER: carrier, TAXCODE: taxcode, HELP: helptext };

const CACHE_TTL = 60; // seconds: the edge cache's lifetime for a table read

const kvKey = (name: string) => `table:${name}`;

export function table(name: string): Table {
	const t = tables[name.toUpperCase()];
	if (!t) throw new HttpError(404, "not_found", `no system table ${name.toUpperCase()}: use ${Object.keys(tables).join(", ")}`);
	return t;
}

// readTable returns a table's rows by key, and whether it was changed from
// its defaults.
export async function readTable(kv: KVNamespace, name: string): Promise<{ rows: Record<string, Row>; custom: boolean }> {
	const t = table(name);
	const got = await kv.get<Record<string, Row>>(kvKey(name.toUpperCase()), { type: "json", cacheTtl: CACHE_TTL });
	return got ? { rows: got, custom: true } : { rows: structuredClone(t.defaults), custom: false };
}

export interface TableInfo { name: string; title: string; desc: string; rows: number; custom: boolean }

export async function listTables(kv: KVNamespace): Promise<TableInfo[]> {
	return Promise.all(Object.entries(tables).map(async ([name, t]) => {
		const { rows, custom } = await readTable(kv, name);
		return { name, title: t.title, desc: t.desc, rows: Object.keys(rows).length, custom };
	}));
}

// sorted returns the rows as a list, ordered by key, each with its key.
export function sorted(rows: Record<string, Row>): (Row & { key: string })[] {
	return Object.keys(rows).sort().map((key) => ({ key, ...rows[key] }));
}

// parseRow checks a row from the API or a screen against the table's
// columns. Values may be strings, as typed on a screen, or numbers. The
// field on an error is the column name.
export function parseRow(t: Table, raw: Record<string, unknown>): Row {
	const row: Row = {};
	for (const c of t.columns) {
		const v = raw[c.name];
		if (c.kind === "lines") {
			const lines = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : v === undefined ? [] : null;
			if (!lines || lines.some((l) => typeof l !== "string")) throw invalid(c.name, `${c.label} must be a list of lines`);
			const text = (lines as string[]).map((l) => l.trimEnd());
			while (text.length > 0 && text.at(-1) === "") text.pop();
			if (text.length > (c.lines ?? 1)) throw invalid(c.name, `${c.label} has more than ${c.lines} lines`);
			if (text.some((l) => l.length > c.len)) throw invalid(c.name, `${c.label} lines are at most ${c.len} characters`);
			row[c.name] = text;
			continue;
		}
		if (v !== undefined && typeof v !== "string" && typeof v !== "number") throw invalid(c.name, `${c.label} must be a string or number`);
		const s = String(v ?? "").trim();
		if (c.kind === "text") {
			const up = s.toUpperCase().replace(/\s+/g, " ");
			if (up.length > c.len) throw invalid(c.name, `${c.label} is at most ${c.len} characters`);
			if (c.pattern && !c.pattern.test(up)) throw invalid(c.name, `${c.label} must be ${c.hint}`);
			row[c.name] = up;
			continue;
		}
		const ok = c.kind === "int" ? /^\d+$/.test(s) : /^(\d+(\.\d{0,3})?|\.\d{1,3})$/.test(s);
		const n = Number(s);
		if (!ok || n < (c.min ?? 0) || n > (c.max ?? Number.MAX_SAFE_INTEGER)) {
			const what = c.kind === "int" ? "a whole number" : "a number with up to 3 decimals";
			throw invalid(c.name, `${c.label} must be ${what} from ${c.min ?? 0} to ${c.max}`);
		}
		row[c.name] = n;
	}
	return row;
}

export function parseKey(t: Table, key: string): string {
	const k = key.trim().toUpperCase();
	if (!t.key.pattern.test(k)) throw invalid("key", `${t.key.label} must be ${t.key.hint}`);
	return k;
}

// putRow adds or replaces a row and logs the change.
export async function putRow(kv: KVNamespace, db: D1Database, user: string, name: string, key: string, raw: Record<string, unknown>): Promise<Row & { key: string }> {
	const t = table(name);
	name = name.toUpperCase();
	const k = parseKey(t, key);
	const row = parseRow(t, raw);
	const { rows } = await readTable(kv, name);
	const verb = rows[k] ? "CHANGED" : "ADDED";
	rows[k] = row;
	await kv.put(kvKey(name), JSON.stringify(rows));
	await syslog(db, user, `CUS0801I ${user} ${verb} ${name} ${k}`);
	return { key: k, ...row };
}

export async function deleteRow(kv: KVNamespace, db: D1Database, user: string, name: string, key: string): Promise<void> {
	table(name);
	name = name.toUpperCase();
	const k = key.trim().toUpperCase();
	const { rows } = await readTable(kv, name);
	if (!rows[k]) throw new HttpError(404, "not_found", `${name} has no entry ${k}`);
	delete rows[k];
	await kv.put(kvKey(name), JSON.stringify(rows));
	await syslog(db, user, `CUS0802I ${user} DELETED ${name} ${k}`);
}

// resetTable puts a table back to its defaults.
export async function resetTable(kv: KVNamespace, db: D1Database, user: string, name: string): Promise<void> {
	table(name);
	name = name.toUpperCase();
	await kv.delete(kvKey(name));
	await syslog(db, user, `CUS0803I ${user} RESET ${name} TO ITS DEFAULTS`);
}

// Lookups for the rest of the system.

export interface Carrier {
	code: string;
	name: string;
	priority: number;
	service_states: string[]; // empty: anywhere
	min_weight_lb: number;
	max_weight_lb: number; // 0: no limit, and the same for the others
	max_carton_lb: number;
	min_value: number; // whole dollars
	max_value: number;
	base_charge: number; // dollars
	per_lb: number;
	transit_days: number;
}

// carrierRates returns the carriers in priority order.
export async function carrierRates(kv: KVNamespace): Promise<Carrier[]> {
	const { rows } = await readTable(kv, "CARRIER");
	return sorted(rows)
		.map((r) => ({
			...(r as unknown as Omit<Carrier, "code" | "service_states">),
			code: r.key,
			service_states: String(r.service_states ?? "").split(" ").filter(Boolean),
		}))
		.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}

export interface Order {
	state: string; // ship-to
	weight: number; // pounds, the whole shipment
	maxCarton: number; // pounds, the heaviest carton
	value: number; // whole dollars
}

// chooseCarrier returns the first carrier, by priority, whose limits the
// order is within, or undefined if none takes it.
export function chooseCarrier(carriers: Carrier[], o: Order): Carrier | undefined {
	const within = (n: number, min: number, max: number) => n >= min && (max === 0 || n <= max);
	return carriers.find((c) =>
		(c.service_states.length === 0 || c.service_states.includes(o.state.toUpperCase())) &&
		within(o.weight, c.min_weight_lb, c.max_weight_lb) &&
		(c.max_carton_lb === 0 || o.maxCarton <= c.max_carton_lb) &&
		within(o.value, c.min_value, c.max_value),
	);
}

// freight is what a carrier charges for a shipment, in dollars.
export function freight(c: Carrier, weight: number): number {
	return Math.round((c.base_charge + c.per_lb * weight) * 100) / 100;
}

// taxRate returns the sales tax percentage for a ship-to state, 0 if the
// state is not in the table.
export async function taxRate(kv: KVNamespace, state: string): Promise<{ rate: number; freight: boolean }> {
	const { rows } = await readTable(kv, "TAXCODE");
	const r = rows[state.trim().toUpperCase()];
	return r ? { rate: Number(r.rate), freight: r.freight === "Y" } : { rate: 0, freight: false };
}

// helpText returns the help table's text for a field, by panel and field
// first, then by field alone, the same order as the built-in help.
export async function helpText(kv: KVNamespace, panel: string, field: string): Promise<{ title: string; lines: string[] } | undefined> {
	const { rows } = await readTable(kv, "HELP");
	const r = rows[`${panel}.${field}`.toUpperCase()] ?? rows[field.toUpperCase()];
	return r ? { title: String(r.title), lines: (r.text as string[]) ?? [] } : undefined;
}

function invalid(field: string, msg: string): HttpError {
	return new HttpError(422, "invalid", msg, field);
}
