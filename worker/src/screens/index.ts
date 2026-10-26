// POST /v1/screen: the terminal's screens, served by the Worker. The
// protocol is described in docs/screen-protocol.md. A client sends the AID
// key, its input fields and the commarea from the last reply; this module
// runs the panel the commarea names and answers with the next screen.

import type { Env } from "../index";
import { HttpError, int, str } from "../http";
import { syslog } from "../syslog";
import { activity, event } from "./activity";
import { archdoc, archive } from "./archive";
import { mail, mailmsg } from "./mail";
import { ask } from "./ask";
import { browse } from "./browse";
import { chart } from "./charts";
import { opconsole, schedule } from "./console";
import { detail } from "./detail";
import { helpFor } from "./fieldhelp";
import { edi, edidoc } from "./edi";
import { help } from "./help";
import { invaddr, invoice, invoices } from "./invoices";
import { joblog, jobs } from "./jobs";
import { product, products } from "./products";
import { po, pos, vendors } from "./purchasing";
import { vendhist } from "./vendhist";
import { shipment, shipments } from "./shipping";
import { glaccount, ledger } from "./ledger";
import { menu } from "./menu";
import { monitor } from "./monitor";
import { tablerow, tablerows, tables } from "./tables";
import { report } from "./report";
import { search } from "./search";
import { skusearch } from "./skusearch";
import { output, spool } from "./spool";
import { tso } from "../sessions";
import { breakIn, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, time, type Ctx, type Screen } from "./screen";
import { isSend, send } from "./send";
import { takeDownload, takeFill, withFill, type Download, type Input, type Next, type Program, type State } from "./program";

export const requestKeys = [
	"v", "aid", "state", "fields", "modified", "cursor", "rows", "cols", "terminal", "system", "tz_offset", "live",
] as const;

const programs: { [P in State["p"]]: Program<Extract<State, { p: P }>> } = {
	menu, browse, detail, report, chart, help, activity, event, jobs, joblog, products, product, invoices, invoice, invaddr, skusearch, edi, edidoc,
	pos, po, vendors, vendhist, shipments, shipment, ledger, glaccount,
	console: opconsole, schedule, spool, output, search, monitor, tables, tablerows, tablerow, ask, archive, archdoc, mail, mailmsg,
};

// Panels with a command line, by the name of its field. What is entered
// there goes in the session's command history, newest first, and PF24
// (RETRIEVE, as in ISPF) puts it back on the command line: once for the
// last command, again for the one before.
const commandLines: Partial<Record<State["p"], string>> = { menu: "option", console: "cmd", ask: "q" };
const HISTORY = 20;

// An idle terminal logs itself off with TIMEOUT, like TSO's S522.
const timeoutMessage = (ctx: Ctx) => `IKJ56470I ${ctx.user} LOGGED OFF AT ${time(ctx)} - SESSION IDLE TOO LONG (S522)`;

// The commarea's own version. Bump it when a state shape changes in a way
// old states cannot be read; clients holding an old one go back to the menu.
const STATE_VERSION = 1;

const aids = new Set([
	"ENTER", "CLEAR", "PA1", "PA2", "PA3",
	...Array.from({ length: 24 }, (_, i) => `PF${i + 1}`),
]);

export type ScreenResponse =
	| { v: 1; state: string; screen: ReturnType<Screen["toJSON"]>; download?: Download }
	| { v: 1; logoff: { message: string } };

export async function screen(env: Env, user: string, url: URL, body: Record<string, unknown>): Promise<ScreenResponse> {
	if (body.v !== 1) throw bad('"v" must be 1');
	const aid = str(body, "aid");
	const ctx: Ctx = {
		env,
		db: env.DB,
		tables: env.TABLES,
		jobs: env.JOBS,
		tso: tso(env),
		user,
		sid: "",
		rows: clamp(int(body, "rows"), MIN_ROWS, MAX_ROWS),
		cols: clamp(int(body, "cols"), MIN_COLS, MAX_COLS),
		system: str(body, "system") || "SYS1",
		terminal: str(body, "terminal") || "TERM0001",
		host: url.host,
		tzOffset: clamp(int(body, "tz_offset"), -14 * 60, 14 * 60),
		live: body.live === true,
	};

	let next: Next;
	let session: Session = { history: [] };
	let before: State | undefined; // the screen as it was, to go back to if a lock is refused
	const got = aid === "START" ? undefined : decode(str(body, "state"));
	if (got) session = got.session;
	ctx.sid = session.sid ?? "";
	if (aid === "START") {
		ctx.sid = await ctx.tso.logon(user, ctx.terminal);
		next = { p: "menu", msg: `IKJ56455I ${user} LOGON IN PROGRESS AT ${time(ctx)}` };
		await syslog(env.DB, user, `IKJ56455I ${user} LOGON IN PROGRESS ON ${ctx.terminal}`);
	} else if (aid === "TIMEOUT") {
		await syslog(env.DB, user, `IEF450I ${user} TSO - ABEND=S522 - IDLE TIME LIMIT EXCEEDED ON ${ctx.terminal}`);
		next = { logoff: timeoutMessage(ctx) };
	} else {
		const current = got?.s;
		const cmdField = current ? commandLines[current.p] : undefined;
		before = current && structuredClone(current);
		const held = current ? locksOf(current) : [];
		const lost = held.length > 0 && aid !== "REDRAW" ? await ctx.tso.hold(ctx.sid, user, ctx.terminal, held) : undefined;
		if (lost) ctx.sid = lost.sid;
		if (!current) {
			next = { p: "menu", msg: "CUS0001W SCREEN STATE LOST OR FROM AN OLDER RELEASE - BACK AT MENU" };
		} else if (aid === "REDRAW") {
			next = current;
		} else if (!aids.has(aid)) {
			throw bad(`unknown aid "${aid}"`);
		} else if (lost?.lost) {
			// The session ended with a record locked and someone else has
			// it now: what was typed cannot be saved.
			next = unlock(current);
			before = undefined;
			setAnyMsg(next, `CUS1202E LOCK LOST TO ${lost.lost.user} ON ${lost.lost.terminal} - ${lost.lost.resource} NOT CHANGED`);
		} else if (aid === "PF1" && current.p !== "help") {
			// PF1 is help on every screen: for the field the cursor is in if
			// it has any, otherwise the tutorial. What the operator typed is
			// kept for when they come back.
			const inp = input(body, aid);
			const vals = Object.fromEntries([...inp.modified].filter((n) => n in inp.fields).map((n) => [n, inp.fields[n]]));
			const h = { p: "help" as const, back: current, ...(Object.keys(vals).length ? { vals } : {}) };
			next = (await helpFor(env.TABLES, current, inp.cursorField)) ? { ...h, field: inp.cursorField } : h;
		} else if (aid === "PF24" && cmdField) {
			next = retrieve(current, cmdField, session);
		} else {
			const inp = input(body, aid);
			session.retrieved = undefined;
			const cmd = (inp.fields[cmdField ?? ""] ?? "").trim();
			if (aid === "ENTER" && cmdField && cmd) {
				session.history = [cmd, ...session.history.filter((c) => c !== cmd)].slice(0, HISTORY);
			}
			if (aid === "ENTER" && cmdField && isSend(cmd)) {
				// SEND works from any command line, as a TSO command does.
				next = current;
				setAnyMsg(next, await send(ctx, cmd));
			} else {
				next = await (programs[current.p] as Program<State>).handle(ctx, current, inp);
			}
		}
	}

	if ("logoff" in next) {
		if (ctx.sid) await ctx.tso.logoff(ctx.sid, user);
		await syslog(env.DB, user, `IKJ56470I ${user} LOGGED OFF ${ctx.terminal}`);
		return { v: 1, logoff: { message: next.logoff } };
	}
	const fill = takeFill(next);
	let download = takeDownload(next);
	let scr = await (programs[next.p] as Program<State>).render(ctx, next);
	if (fill) scr.fill(fill.fields, fill.cursor);

	// Take the locks the new screen needs and release the rest. If another
	// session has one, stay on the screen as it was before the key.
	const sync = await ctx.tso.sync(ctx.sid, user, ctx.terminal, scr.map, locksOf(next));
	session.sid = sync.sid;
	if (sync.conflict) {
		const h = sync.conflict;
		next = before ?? { p: "menu" };
		setAnyMsg(next, `CUS1201E RECORD IN USE BY ${h.user} ON ${h.terminal} - ${h.resource}`);
		scr = await (programs[next.p] as Program<State>).render(ctx, next);
		download = undefined;
	}
	if (sync.message) breakIn(scr, sync.message.from, sync.message.text);
	return { v: 1, state: encode(next, session), screen: scr.toJSON(), ...(download ? { download } : {}) };
}

// locksOf lists the records held for update by s and the panels under it,
// such as a customer being changed under the help panel opened from it.
function locksOf(s: State): string[] {
	const out: string[] = [];
	for (let st: State | undefined = s; st; st = (st as { back?: State }).back) {
		out.push(...((programs[st.p] as Program<State>).locks?.(st) ?? []));
	}
	return out;
}

// unlock returns the screen that held the lost locks, without them.
function unlock(s: State): State {
	for (let st: State | undefined = s; st; st = (st as { back?: State }).back) {
		const p = programs[st.p] as Program<State>;
		if (p.locks?.(st).length && p.unlocked) return p.unlocked(st);
	}
	return s;
}

function setAnyMsg(s: State, msg: string): void {
	(s as { msg?: string }).msg = msg;
}

// Session is what the commarea carries for the whole conversation rather
// than for one panel.
interface Session {
	sid?: string; // the TSO session (sessions.ts)
	history: string[]; // commands entered, newest first
	retrieved?: number; // the history entry PF24 last put back
}

// retrieve puts the next older command from the history on the command line.
function retrieve(s: State, field: string, session: Session): State {
	if (session.history.length === 0) {
		(s as { msg?: string }).msg = "CUS1101I NO COMMANDS TO RETRIEVE";
		return withFill(s, { fields: { [field]: "" }, cursor: field });
	}
	const n = session.retrieved === undefined ? 0 : (session.retrieved + 1) % session.history.length;
	session.retrieved = n;
	(s as { msg?: string }).msg = "";
	return withFill(s, { fields: { [field]: session.history[n] }, cursor: field });
}

function input(body: Record<string, unknown>, aid: string): Input {
	const fields: Record<string, string> = {};
	const raw = body.fields ?? {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad('"fields" must be an object');
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== "string") throw bad(`field "${k}" must be a string`);
		fields[k] = v;
	}
	const modified = body.modified ?? [];
	if (!Array.isArray(modified) || modified.some((m) => typeof m !== "string")) {
		throw bad('"modified" must be a list of field names');
	}
	const cursor = body.cursor;
	const cursorField = typeof cursor === "object" && cursor !== null && "field" in cursor && typeof cursor.field === "string"
		? cursor.field : "";
	return { aid, fields, modified: new Set(modified as string[]), cursorField };
}

function encode(s: State, session: Session): string {
	const out: Record<string, unknown> = { sv: STATE_VERSION, s };
	if (session.sid) out.t = session.sid;
	if (session.history.length > 0) out.h = session.history;
	if (session.retrieved !== undefined) out.r = session.retrieved;
	return JSON.stringify(out);
}

// decode reads a commarea, or returns undefined if it is missing, damaged
// or from an incompatible release.
function decode(raw: string): { s: State; session: Session } | undefined {
	try {
		const { sv, s, h, r, t } = JSON.parse(raw);
		if (sv !== STATE_VERSION || !valid(s)) return undefined;
		const history = Array.isArray(h) ? h.filter((c): c is string => typeof c === "string").slice(0, HISTORY) : [];
		const retrieved = Number.isInteger(r) && r >= 0 && r < history.length ? (r as number) : undefined;
		return { s, session: { history, retrieved, sid: typeof t === "string" ? t : undefined } };
	} catch {
		return undefined;
	}
}

function valid(s: unknown, depth = 0): s is State {
	if (typeof s !== "object" || s === null || depth > 8) return false;
	const st = s as { p?: unknown; back?: unknown };
	if (typeof st.p !== "string" || !Object.hasOwn(programs, st.p)) return false;
	return st.back === undefined || valid(st.back, depth + 1);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

function bad(msg: string): HttpError {
	return new HttpError(400, "bad_request", "invalid request body: " + msg);
}
