// Cron expressions for the job scheduler: the five classic fields,
// minute hour day-of-month month day-of-week, evaluated in UTC. Each field
// takes *, a number, a range (1-5), a step (*/15, 0-30/10) or a list of
// those (1,15). Months and weekdays also take names (JAN, MON), weekday 7
// is Sunday like 0, and @hourly, @daily, @weekly, @monthly and @yearly are
// shorthands. As in Vixie cron, when both day fields are restricted a day
// matching either one runs.

export interface Cron {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	anyDom: boolean;
	anyDow: boolean;
}

export class CronError extends Error {}

const shorthands: Record<string, string> = {
	"@HOURLY": "0 * * * *",
	"@DAILY": "0 0 * * *",
	"@MIDNIGHT": "0 0 * * *",
	"@WEEKLY": "0 0 * * 0",
	"@MONTHLY": "0 0 1 * *",
	"@YEARLY": "0 0 1 1 *",
	"@ANNUALLY": "0 0 1 1 *",
};

const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// normalize upper-cases an expression and collapses its spacing, the way
// it is stored and shown.
export function normalize(expr: string): string {
	return expr.trim().toUpperCase().split(/\s+/).join(" ");
}

export function parseCron(expr: string): Cron {
	const norm = normalize(expr);
	const parts = (shorthands[norm] ?? norm).split(" ");
	if (parts.length !== 5) throw new CronError("needs 5 fields: minute hour day month weekday");
	const [mi, h, dom, mo, dow] = parts;
	const weekdays = field(dow, 0, 7, "weekday", days);
	if (weekdays.delete(7)) weekdays.add(0);
	return {
		minute: field(mi, 0, 59, "minute"),
		hour: field(h, 0, 23, "hour"),
		dom: field(dom, 1, 31, "day"),
		month: field(mo, 1, 12, "month", months, 1),
		dow: weekdays,
		anyDom: dom === "*",
		anyDow: dow === "*",
	};
}

function field(s: string, lo: number, hi: number, what: string, names: string[] = [], base = 0): Set<number> {
	const num = (t: string): number => {
		const named = names.indexOf(t);
		if (named >= 0) return named + base;
		if (!/^\d{1,2}$/.test(t)) throw new CronError(`bad ${what} "${t}"`);
		const n = Number(t);
		if (n < lo || n > hi) throw new CronError(`${what} ${n} is not ${lo}-${hi}`);
		return n;
	};
	const out = new Set<number>();
	for (const item of s.split(",")) {
		const [range, stepText, extra] = item.split("/");
		if (extra !== undefined) throw new CronError(`bad ${what} "${item}"`);
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d{1,2}$/.test(stepText) || Number(stepText) === 0) throw new CronError(`bad ${what} step "${stepText}"`);
			step = Number(stepText);
		}
		let from: number;
		let to: number;
		if (range === "*") {
			[from, to] = [lo, hi];
		} else if (range.includes("-")) {
			const [a, b] = range.split("-");
			[from, to] = [num(a), num(b)];
			if (from > to) throw new CronError(`bad ${what} range "${range}"`);
		} else {
			from = num(range);
			to = stepText === undefined ? from : hi; // 5/15 means from 5, every 15
		}
		for (let n = from; n <= to; n += step) out.add(n);
	}
	return out;
}

function dayMatches(c: Cron, d: Date): boolean {
	const dom = c.dom.has(d.getUTCDate());
	const dow = c.dow.has(d.getUTCDay());
	if (c.anyDom && c.anyDow) return true;
	if (c.anyDom) return dow;
	if (c.anyDow) return dom;
	return dom || dow;
}

// matches tells whether the cron runs in the minute that contains at.
export function matches(c: Cron, at: Date): boolean {
	return c.minute.has(at.getUTCMinutes()) && c.hour.has(at.getUTCHours()) &&
		c.month.has(at.getUTCMonth() + 1) && dayMatches(c, at);
}

// nextRun returns the first minute after at that the cron runs in, or
// undefined if there is none in the next five years (such as 30 FEB).
export function nextRun(c: Cron, at: Date): Date | undefined {
	const start = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + 60_000);
	const minutes = [...c.minute].sort((a, b) => a - b);
	const hours = [...c.hour].sort((a, b) => a - b);
	const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
	for (let i = 0; i < 5 * 366; i++, day.setUTCDate(day.getUTCDate() + 1)) {
		if (!c.month.has(day.getUTCMonth() + 1) || !dayMatches(c, day)) continue;
		for (const h of hours) {
			for (const m of minutes) {
				const t = new Date(day.getTime() + (h * 60 + m) * 60_000);
				if (t >= start) return t;
			}
		}
	}
	return undefined;
}
