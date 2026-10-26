import { listCustomers } from "../data";
import { AGING_BUCKETS, agedAccounts, inventoryTurns, salesByMonth, type MonthSales } from "../reports";
import { spoolReport } from "../spool";
import { header, invalidKey, keys, lpad, message, MIN_COLS, money, newScreen, pad, textLines, time, type Color, type Ctx } from "./screen";
import { fail, pf, type ChartState, type Next, type Program } from "./program";

// The management reports, drawn as character charts the way a 3270 report
// writer would: CUSR02 SALES BY MONTH (invoiced and collected, as a bar
// chart), CUSR03 RECEIVABLES AGING (aging buckets and the accounts behind
// them), CUSR04 INVENTORY TURNS (turns per product) and CUSR05 MANAGEMENT
// DASHBOARD, which sums them up on one screen. PF9 prints a report to the
// spool at 80 columns, every line of it.

interface Seg { col: number; text: string; color?: Color; bright?: boolean }
type Line = Seg[];

// A report is its lines: the first fixed of them stay put, and the rest
// scroll with PF7 and PF8.
interface Body { lines: Line[]; fixed: number }

type Kind = ChartState["kind"];

const kinds: Record<Kind, { map: string; title: string; build: (ctx: Ctx) => Promise<Body> }> = {
	S: { map: "CUSR02", title: "SALES BY MONTH", build: sales },
	A: { map: "CUSR03", title: "RECEIVABLES AGING", build: aging },
	T: { map: "CUSR04", title: "INVENTORY TURNS", build: turns },
	D: { map: "CUSR05", title: "MANAGEMENT DASHBOARD", build: dashboard },
};

// The body fills row 4 to the row above the message line.
const bodyRows = (ctx: Ctx) => ctx.rows - 5;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthName = (m: MonthSales) => MONTHS[Number(m.month.slice(5, 7)) - 1];
const bucketColors: Color[] = ["green", "yellow", "pink", "red"];

const lbl = (col: number, text: string): Seg => ({ col, text, color: "turquoise" });
const val = (col: number, text: string, color: Color = "green"): Seg => ({ col, text, color });
const heading = (text: string): Line => [{ col: 2, text, color: "white", bright: true }];

// compact formats dollars in five characters or fewer: $950, $9.9K, $123K.
export function compact(n: number): string {
	const v = Math.round(n);
	if (v < 1000) return "$" + v;
	if (v < 9950) return "$" + (v / 1000).toFixed(1) + "K";
	if (v < 999_500) return "$" + Math.round(v / 1000) + "K";
	if (v < 9_950_000) return "$" + (v / 1e6).toFixed(1) + "M";
	return "$" + Math.round(v / 1e6) + "M";
}

// niceMax rounds a chart's top value up to 1, 2, 2.5 or 5 times a power
// of ten, so the axis steps are round numbers.
export function niceMax(v: number): number {
	if (v <= 0) return 1000;
	const p = 10 ** Math.floor(Math.log10(v));
	return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

// bar is the length of a bar for v on a scale where max fills width; any
// value above zero shows at least one character.
function bar(v: number, max: number, width: number): number {
	if (v <= 0 || max <= 0) return 0;
	return Math.min(Math.max(Math.round((v * width) / max), 1), width);
}

const turnsColor = (t: number): Color => (t < 1 ? "red" : t < 4 ? "yellow" : "green");
const daysText = (d: number) => (d === Infinity ? "--" : String(Math.min(d, 9999)));

async function sales(ctx: Ctx): Promise<Body> {
	const months = await salesByMonth(ctx.db, 12);
	const H = 10;
	const top = niceMax(Math.max(...months.map((m) => Math.max(m.sales, m.collected))));
	const sum = (f: (m: MonthSales) => number) => months.reduce((t, m) => t + f(m), 0);
	const first = months[0];
	const last = months.at(-1)!;
	const cell = (i: number) => 9 + 6 * i;

	const lines: Line[] = [
		[
			val(2, "##"), lbl(5, "INVOICED"), val(14, money(sum((m) => m.sales)), "white"),
			val(28, "==", "turquoise"), lbl(31, "COLLECTED"), val(41, money(sum((m) => m.collected)), "white"),
			val(56, `${monthName(first)} ${first.month.slice(0, 4)} - ${monthName(last)} ${last.month.slice(0, 4)}`, "blue"),
		],
		[],
	];
	for (let r = 0; r < H; r++) {
		const line: Line = [val(2, r % 2 === 0 ? lpad(compact((top * (H - r)) / H), 6) : "", "blue"), val(8, "|", "blue")];
		months.forEach((m, i) => {
			if (bar(m.sales, top, H) >= H - r) line.push(val(cell(i) + 1, "##"));
			if (bar(m.collected, top, H) >= H - r) line.push(val(cell(i) + 3, "==", "turquoise"));
		});
		lines.push(line);
	}
	lines.push([val(2, lpad("$0", 6), "blue"), val(8, "+" + "-".repeat(72), "blue")]);
	lines.push(months.map((m, i) => val(cell(i) + 1, monthName(m), "white")));
	lines.push([]);
	const row = (name: string, f: (m: MonthSales) => string, color: Color): Line =>
		[lbl(2, name), ...months.map((m, i) => val(cell(i), lpad(f(m), 5), color))];
	lines.push(
		row("SALES", (m) => (m.sales ? compact(m.sales) : "-"), "green"),
		row("COLLECT", (m) => (m.collected ? compact(m.collected) : "-"), "turquoise"),
		row("COUNT", (m) => (m.invoices ? String(m.invoices) : "-"), "white"),
	);
	return { lines, fixed: lines.length };
}

async function aging(ctx: Ctx): Promise<Body> {
	const accts = await agedAccounts(ctx.db);
	const totals = [0, 1, 2, 3].map((i) => accts.reduce((t, a) => t + a.buckets[i], 0));
	const total = totals.reduce((a, b) => a + b, 0);
	const width = 46 + ctx.cols - MIN_COLS;

	const lines: Line[] = [
		[lbl(2, "TOTAL RECEIVABLE"), val(20, money(total), "white"), lbl(40, "ACCOUNTS WITH A BALANCE"), val(64, String(accts.length), "white")],
		[],
	];
	AGING_BUCKETS.forEach((name, i) => {
		const pct = total > 0 ? Math.round((totals[i] * 100) / total) : 0;
		const n = bar(totals[i], total, width);
		lines.push([
			lbl(4, name), val(14, lpad(money(totals[i]), 12)), val(27, lpad(pct, 3) + "%", "white"),
			val(33, "#".repeat(n), bucketColors[i]), val(33 + n, ".".repeat(width - n), "blue"),
		]);
	});
	lines.push(
		[],
		heading("CUST NO NAME                    CURRENT     31-60     61-90   OVER 90     TOTAL"),
		[val(2, "------- -------------------- --------- --------- --------- --------- ----------", "blue")],
	);
	const fixed = lines.length;

	// The oldest money comes first.
	const sorted = [...accts].sort((a, b) =>
		b.buckets[3] - a.buckets[3] || b.buckets[2] - a.buckets[2] || b.buckets[1] - a.buckets[1] || b.balance - a.balance);
	for (const a of sorted) {
		const line: Line = [val(2, `${pad(a.id, 7)} ${pad(a.name, 20)}`)];
		a.buckets.forEach((b, i) => {
			if (b) line.push(val(31 + 10 * i, lpad(money(b), 9), bucketColors[i]));
		});
		line.push(val(71, lpad(money(a.balance), 10), "white"));
		lines.push(line);
	}
	lines.push(
		[val(2, "------- -------------------- --------- --------- --------- --------- ----------", "blue")],
		[lbl(2, "TOTALS"), ...totals.map((t, i) => val(31 + 10 * i, lpad(money(t), 9), bucketColors[i])), val(71, lpad(money(total), 10), "white")],
	);
	return { lines, fixed };
}

async function turns(ctx: Ctx): Promise<Body> {
	const t = await inventoryTurns(ctx.db);
	const width = 18 + ctx.cols - MIN_COLS;
	const slow = t.items.filter((p) => p.turns < 1 && p.on_hand > 0);
	const lines: Line[] = [
		[
			lbl(2, "INVENTORY AT COST"), val(21, money(t.value), "white"),
			lbl(36, "TURNS/YR"), val(46, t.turns.toFixed(1), turnsColor(t.turns)),
			lbl(54, "DAYS ON HAND"), val(68, t.cogs > 0 ? String(Math.round((t.value * 365) / t.cogs)) : "--", "white"),
		],
		[
			lbl(2, "COST OF SALES/YR"), val(21, money(t.cogs), "white"),
			lbl(36, "UNDER 1 TURN"), val(50, `${slow.length} SKUS HOLDING ${money(slow.reduce((v, p) => v + p.value, 0))}`, slow.length ? "red" : "green"),
		],
		[val(2, `RATES ARE ANNUALIZED FROM THE LAST ${t.days} DAYS OF SALES AND RECEIPTS`, "blue")],
		[],
		heading("SKU        DESCRIPTION        ON HAND     VALUE TURNS  DAYS"),
		[val(2, "---------- ------------------ ------- --------- ----- -----", "blue")],
	];
	const fixed = lines.length;
	const max = Math.max(...t.items.map((p) => p.turns), 1);
	const sorted = [...t.items].sort((a, b) => b.turns - a.turns || b.value - a.value);
	for (const p of sorted) {
		const n = bar(p.turns, max, width);
		lines.push([
			val(2, `${pad(p.sku, 10)} ${pad(p.description, 18)} ${lpad(p.on_hand, 7)} ${lpad(money(p.value), 9)}`),
			val(50, lpad(p.turns.toFixed(1), 5), turnsColor(p.turns)),
			val(56, lpad(daysText(p.days), 5), "white"),
			val(62, "#".repeat(n), turnsColor(p.turns)),
		]);
	}
	return { lines, fixed };
}

const RAMP = "_.:-=+*#";

async function dashboard(ctx: Ctx): Promise<Body> {
	const [months, accts, inv, custs] = await Promise.all([
		salesByMonth(ctx.db, 12), agedAccounts(ctx.db), inventoryTurns(ctx.db), listCustomers(ctx.db, ""),
	]);
	const cur = months.at(-1)!.sales;
	const prev = months.at(-2)!.sales;
	const year = months.reduce((t, m) => t + m.sales, 0);
	const peak = Math.max(...months.map((m) => m.sales));
	const change: Seg[] = prev > 0
		? [val(56, (cur >= prev ? "+" : "") + Math.round(((cur - prev) * 100) / prev) + "%", cur >= prev ? "green" : "red")]
		: [];

	const totals = [0, 1, 2, 3].map((i) => accts.reduce((t, a) => t + a.buckets[i], 0));
	const owed = totals.reduce((a, b) => a + b, 0);
	const late = totals[2] + totals[3];
	const width = 60 + ctx.cols - MIN_COLS;
	const stack: Seg[] = [];
	if (owed > 0) {
		// Each bucket's share of the bar, rounded so the shares add up.
		let at = 0;
		let run = 0;
		totals.forEach((t, i) => {
			run += t;
			const end = Math.round((run * width) / owed);
			if (end > at) stack.push(val(4 + at, "#".repeat(end - at), bucketColors[i]));
			at = end;
		});
	} else {
		stack.push(val(4, "NO RECEIVABLES OUTSTANDING", "blue"));
	}

	const reorder = inv.items.filter((p) => p.status === "A" && p.reorder_point > 0 && p.on_hand <= p.reorder_point).length;
	const slow = inv.items.filter((p) => p.turns < 1 && p.on_hand > 0).length;
	const held = custs.filter((c) => c.status === "H").length;
	const near = custs.filter((c) => c.status === "A" && c.credit_limit > 0 && c.balance * 10 >= c.credit_limit * 9).length;
	const warn = (n: number): Color => (n > 0 ? "yellow" : "green");

	const lines: Line[] = [
		heading("SALES"),
		[lbl(4, "THIS MONTH"), val(18, money(cur), "white"), lbl(30, "LAST MONTH"), val(42, money(prev), "white"), ...change],
		[
			lbl(4, "12 MONTHS"), val(18, money(year), "white"), lbl(30, "TREND"),
			val(42, months.map((m) => RAMP[m.sales > 0 ? 1 + Math.floor((m.sales / peak) * (RAMP.length - 1.001)) : 0]).join(" ")),
		],
		[val(42, months.map((m) => monthName(m)[0]).join(" "), "blue")],
		[],
		heading("RECEIVABLES"),
		[
			lbl(4, "OUTSTANDING"), val(18, money(owed), "white"), lbl(30, "OVER 60 DAYS"),
			val(44, `${money(late)} (${owed > 0 ? Math.round((late * 100) / owed) : 0}%)`, late > 0 ? "red" : "green"),
		],
		stack,
		AGING_BUCKETS.flatMap((name, i): Seg[] => [val(4 + 14 * i, "#", bucketColors[i]), lbl(6 + 14 * i, name)]),
		[],
		heading("INVENTORY"),
		[
			lbl(4, "AT COST"), val(18, money(inv.value), "white"), lbl(30, "TURNS/YR"), val(42, inv.turns.toFixed(1), turnsColor(inv.turns)),
			lbl(50, "DAYS ON HAND"), val(64, inv.cogs > 0 ? String(Math.round((inv.value * 365) / inv.cogs)) : "--", "white"),
		],
		[lbl(4, "AT REORDER"), val(18, String(reorder), warn(reorder)), lbl(30, "UNDER 1 TURN"), val(44, `${slow} SKUS`, warn(slow))],
		[],
		heading("CREDIT"),
		[lbl(4, "ON HOLD"), val(18, String(held), warn(held)), lbl(30, "NEAR LIMIT"), val(44, `${near} ACCOUNTS AT 90% OR MORE`, warn(near))],
	];
	return { lines, fixed: lines.length };
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

export function newChart(kind: Kind, back: ChartState["back"]): ChartState {
	return { p: "chart", kind, back };
}

export const chart: Program<ChartState> = {
	async render(ctx, s) {
		const k = kinds[s.kind] ?? kinds.D;
		const scr = newScreen(ctx, k.map);
		header(scr, ctx, k.title);

		let body: Body = { lines: [], fixed: 0 };
		let msg = s.msg ?? "";
		try {
			body = await k.build(ctx);
		} catch (e) {
			msg = fail(e);
		}
		const fixed = body.lines.slice(0, body.fixed);
		const rest = body.lines.slice(body.fixed);
		const rows = bodyRows(ctx) - fixed.length;
		const top = Math.min(s.top ?? 0, Math.max(rest.length - rows, 0));
		if (rest.length > rows) {
			const pos = `ROW ${top + 1} TO ${Math.min(top + rows, rest.length)} OF ${rest.length}`;
			scr.text(3, scr.cols - pos.length, pos, { color: "white" });
		}
		[...fixed, ...rest.slice(top, top + rows)].forEach((line, i) => {
			for (const seg of line) {
				if (seg.text) scr.text(4 + i, seg.col, seg.text, { color: seg.color, bright: seg.bright });
			}
		});

		message(scr, msg);
		keys(scr, s.kind === "D"
			? "PF3=EXIT  PF4=SALES  PF5=REFRESH  PF6=AGING  PF9=PRINT  PF10=TURNS  PF12=CANCEL"
			: rest.length > 0
			? "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF7=UP  PF8=DOWN  PF9=PRINT  PF12=CANCEL"
			: "PF1=HELP  PF3=EXIT  PF5=REFRESH  PF9=PRINT  PF12=CANCEL");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, s, input): Promise<Next> {
		s.msg = "";
		const k = kinds[s.kind] ?? kinds.D;
		switch (input.aid) {
			case pf(3):
			case pf(12):
				return s.back ?? { p: "menu" };
			case pf(5):
			case "ENTER":
			case "CLEAR":
				s.msg = "CUS0301I REPORT REFRESHED AT " + time(ctx);
				return s;
			case pf(7):
			case pf(8): {
				if (s.kind === "D") break;
				const body = await k.build(ctx);
				scroll(s, input.aid, bodyRows(ctx) - body.fixed, body.lines.length - body.fixed);
				return s;
			}
			case pf(9): {
				// The whole report goes to the spool at 80 columns, on a screen
				// tall enough that nothing scrolls.
				const body = await k.build({ ...ctx, cols: MIN_COLS });
				const tall = { ...ctx, rows: Math.max(body.lines.length + 5, 24), cols: MIN_COLS };
				const lines = textLines(await chart.render(tall, { p: "chart", kind: s.kind, back: s.back }));
				const id = await spoolReport(ctx.db, ctx.user, k.map, k.title, lines);
				s.msg = `CUS0302I REPORT PRINTED TO THE SPOOL AS ${id} - SEE OPTION 5.4`;
				return s;
			}
			case pf(4):
			case pf(6):
			case pf(10):
				if (s.kind !== "D") break;
				return newChart(input.aid === pf(4) ? "S" : input.aid === pf(6) ? "A" : "T", s);
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};
