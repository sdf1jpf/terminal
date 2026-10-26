import { HttpError } from "../http";
import { deleteRow, listTables, parseKey, putRow, readTable, resetTable, sorted, table, type Row, type Table, type TableInfo } from "../systables";
import { dots, header, invalidKey, keys, label, lpad, message, newScreen, pad, right, type Ctx } from "./screen";
import { fail, isCode, pf, type Program, type TableRowState, type TableRowsState, type TablesState } from "./program";

// The system tables, kept in Workers KV (systables.ts). CUSO04 SYSTEM
// TABLES lists them; S opens CUSO05, a table's rows, where U changes a row
// (CUSO06), D deletes one, PF5 adds one and PF9 twice puts the table back
// to its defaults. Changes are logged to SYSLOG. KV is eventually
// consistent: other locations can see the old value for up to a minute.

export const tables: Program<TablesState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "CUSO04");
		header(scr, ctx, "SYSTEM TABLES");
		let msg = s.msg ?? "";
		let list: TableInfo[] = [];
		try {
			list = await listTables(ctx.tables);
		} catch (e) {
			msg = fail(e);
		}
		scr.text(4, 2, "SELECT: S=SHOW ROWS", { color: "blue" });
		scr.text(6, 2, `S ${pad("TABLE", 8)} ${lpad("ROWS", 5)} ${pad("STATUS", 8)} DESCRIPTION`, { color: "white", bright: true });
		scr.text(7, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		list.forEach((t, i) => {
			scr.input(8 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(8 + i, 4, `${pad(t.name, 8)} ${lpad(t.rows, 5)} ${pad(t.custom ? "CHANGED" : "DEFAULT", 8)} ${t.title}`.slice(0, scr.cols - 5),
				{ color: t.custom ? "green" : "turquoise" });
		});
		s.names = list.map((t) => t.name);
		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF1=HELP  PF3=EXIT  PF12=CANCEL");
		scr.cursorTo(s.errSel ?? "sel0");
		return scr;
	},

	async handle(_ctx, s, input) {
		s.msg = s.errSel = undefined;
		if (input.aid === pf(3) || input.aid === pf(12)) return s.back;
		if (input.aid !== "ENTER") {
			s.msg = invalidKey(input.aid);
			return s;
		}
		for (const [i, name] of (s.names ?? []).entries()) {
			const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code === "S" || code === "/") return { p: "tablerows", back: s, table: name };
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}" - TYPE S BESIDE A TABLE`;
			s.errSel = `sel${i}`;
			return s;
		}
		return s;
	},
};

// rowsShown is how many rows fit on a page: 13 on 24x80.
const rowsShown = (ctx: Ctx) => ctx.rows - 11;

// summary lays out a row's values, other than text blocks, in columns.
function summary(t: Table, r: Row | undefined): string {
	return t.columns
		.filter((c) => c.kind !== "lines")
		.map((c) => {
			const w = Math.min(Math.max(c.len, c.label.length), 18);
			const v = r ? String(r[c.name] ?? "") : c.label;
			return c.kind === "text" || !r ? pad(v, w) : lpad(v, w);
		})
		.join(" ");
}

export const tablerows: Program<TableRowsState> = {
	async render(ctx, s) {
		const t = table(s.table);
		const scr = newScreen(ctx, "CUSO05");
		header(scr, ctx, t.title);
		let msg = s.msg ?? "";
		let list: (Row & { key: string })[] = [];
		let custom = false;
		try {
			const got = await readTable(ctx.tables, s.table);
			list = sorted(got.rows);
			custom = got.custom;
		} catch (e) {
			msg = fail(e);
		}
		const rows = rowsShown(ctx);
		const top = Math.min(s.top ?? 0, Math.max(list.length - rows, 0));
		s.top = top;
		scr.text(3, 2, `TABLE ${s.table} - ${custom ? "CHANGED FROM ITS DEFAULTS" : "DEFAULTS"}`, { color: custom ? "green" : "turquoise" });
		if (list.length > rows) scr.text(3, right(scr, 58), `ROW ${top + 1} TO ${Math.min(top + rows, list.length)} OF ${list.length}`, { color: "white" });
		scr.text(5, 2, "SELECT: U=UPDATE  D=DELETE", { color: "blue" });
		const kw = Math.max(t.key.len, t.key.label.length);
		scr.text(7, 2, `S ${pad(t.key.label, kw)} ${summary(t, undefined)}`.slice(0, scr.cols - 2), { color: "white", bright: true });
		scr.text(8, 2, "-".repeat(scr.cols - 3), { color: "blue" });
		const shown = list.slice(top, top + rows);
		shown.forEach((r, i) => {
			scr.input(9 + i, 2, 1, `sel${i}`, "", { bright: s.errSel === `sel${i}` });
			scr.text(9 + i, 4, `${pad(r.key, kw)} ${summary(t, r)}`.slice(0, scr.cols - 5), { color: "green" });
		});
		if (list.length === 0 && !msg) scr.text(9, 4, "THE TABLE IS EMPTY - PF5 ADDS A ROW", { color: "yellow" });
		s.keys = shown.map((r) => r.key);
		if (s.confirm) msg = `CUS0805W PRESS PF9 AGAIN TO PUT ${s.table} BACK TO ITS DEFAULTS`;
		message(scr, msg);
		keys(scr, "ENTER=PROCESS  PF3=EXIT  PF5=ADD  PF7=UP  PF8=DOWN  PF9=RESET TABLE  PF12=CANCEL");
		scr.cursorTo(s.errSel ?? "sel0");
		return scr;
	},

	async handle(ctx, s, input) {
		const confirm = s.confirm;
		s.msg = s.errSel = s.confirm = undefined;
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
			case pf(12):
				return s.back;
			case pf(5):
				return { p: "tablerow", back: s, table: s.table };
			case pf(7):
				if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
				s.top = Math.max((s.top ?? 0) - rowsShown(ctx), 0);
				return s;
			case pf(8):
				s.top = (s.top ?? 0) + rowsShown(ctx);
				return s;
			case pf(9):
				if (!confirm) {
					s.confirm = true;
					return s;
				}
				try {
					await resetTable(ctx.tables, ctx.db, ctx.user, s.table);
					s.msg = `CUS0803I ${s.table} RESET TO ITS DEFAULTS`;
					s.top = 0;
				} catch (e) {
					s.msg = fail(e);
				}
				return s;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		for (const [i, key] of (s.keys ?? []).entries()) {
			const code = (input.fields[`sel${i}`] ?? "").trim().toUpperCase();
			if (!code) continue;
			switch (code) {
				case "U":
				case "S":
				case "/":
					return { p: "tablerow", back: s, table: s.table, key };
				case "D":
					try {
						await deleteRow(ctx.tables, ctx.db, ctx.user, s.table, key);
						s.msg = `CUS0802I ${s.table} ${key} DELETED`;
					} catch (e) {
						s.msg = isCode(e, "not_found") ? `CUS0804E ${s.table} ${key} IS NO LONGER IN THE TABLE` : fail(e);
					}
					return s;
			}
			s.msg = `CUS0103E INVALID SELECTION CODE "${code}" - USE U OR D`;
			s.errSel = `sel${i}`;
			return s;
		}
		return s;
	},
};

// fieldName is the input field for a column; text blocks have one per line.
const lineField = (name: string, i: number) => `${name}:${i}`;

export const tablerow: Program<TableRowState> = {
	async render(ctx, s) {
		const t = table(s.table);
		const scr = newScreen(ctx, "CUSO06");
		header(scr, ctx, `${t.title} - ${s.key ? "UPDATE" : "ADD"}`);
		let msg = s.msg ?? "";
		let row: Row | undefined;
		if (s.key && !s.vals) {
			try {
				row = (await readTable(ctx.tables, s.table)).rows[s.key];
				if (!row) msg = `CUS0804E ${s.table} ${s.key} IS NO LONGER IN THE TABLE - ENTER ADDS IT`;
			} catch (e) {
				msg = fail(e);
			}
		}
		const val = (name: string): string => {
			if (s.vals) return s.vals[name] ?? "";
			if (name === "key") return s.key ?? "";
			const [col, i] = name.split(":");
			const v = row?.[col];
			if (Array.isArray(v)) return v[Number(i)] ?? "";
			return v === undefined ? "" : String(v);
		};
		const opt = (name: string) => ({ bright: s.errField === name });
		const w = 20;
		let r = 4;
		label(scr, r, 2, dots(t.key.label, w));
		if (s.key) scr.text(r, 3 + w, s.key, { color: "white", bright: true });
		else scr.input(r, 3 + w, t.key.len, "key", val("key"), opt("key"));
		r += 2;
		for (const c of t.columns) {
			if (r > scr.rows - 3) break;
			label(scr, r, 2, dots(c.label, w));
			const len = Math.min(c.len, scr.cols - 4 - w);
			if (c.kind === "lines") {
				const n = Math.min(c.lines ?? 1, scr.rows - 3 - r);
				for (let i = 0; i < n; i++) {
					const name = lineField(c.name, i);
					scr.input(r + 1 + i, 4, Math.min(c.len, scr.cols - 5), name, val(name), { ...opt(name), mixed: true });
				}
				r += n + 1;
			} else {
				scr.input(r, 3 + w, len, c.name, val(c.name), { ...opt(c.name), numeric: c.kind !== "text" && c.kind !== "decimal" });
				r += 1;
			}
		}
		message(scr, msg);
		keys(scr, `ENTER=${s.key ? "SAVE" : "ADD"}  PF1=HELP  PF3=CANCEL  PF12=CANCEL`);
		scr.cursorTo(s.errField ?? (s.key ? t.columns[0].kind === "lines" ? lineField(t.columns[0].name, 0) : t.columns[0].name : "key"));
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errField = undefined;
		if (input.aid === pf(3) || input.aid === pf(12)) return s.back;
		if (input.aid !== "ENTER") {
			s.msg = invalidKey(input.aid);
			return s;
		}
		const t = table(s.table);
		const raw: Record<string, unknown> = {};
		for (const c of t.columns) {
			raw[c.name] = c.kind === "lines"
				? Array.from({ length: c.lines ?? 1 }, (_, i) => input.fields[lineField(c.name, i)] ?? "")
				: input.fields[c.name] ?? "";
		}
		const key = s.key ?? input.fields.key ?? "";
		try {
			if (!s.key) {
				const k = parseKey(t, key);
				if ((await readTable(ctx.tables, s.table)).rows[k]) {
					throw new HttpError(409, "conflict", `${s.table} already has ${k} - use U on the list to change it`, "key");
				}
			}
			const saved = await putRow(ctx.tables, ctx.db, ctx.user, s.table, key, raw);
			s.back.msg = `CUS0801I ${s.table} ${saved.key} ${s.key ? "CHANGED" : "ADDED"}`;
			return s.back;
		} catch (e) {
			s.vals = { ...input.fields, ...(s.key ? {} : { key }) };
			if (e instanceof HttpError && e.field) {
				const c = t.columns.find((x) => x.name === e.field);
				s.errField = c?.kind === "lines" ? lineField(c.name, 0) : e.field;
				s.msg = `CUS0806E ${e.message.toUpperCase()}`;
				return s;
			}
			s.msg = fail(e);
			return s;
		}
	},
};
