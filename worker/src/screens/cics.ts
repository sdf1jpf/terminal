import { AiError, explainAbend } from "../ai";
import {
	abendCode, byId, countUse, deleteq, edfQueue, logAbend, nextTask, queues, readq, setEdf, setStatus, stepInfo,
	termId, tranOf, transactions, tranStats, writeq,
} from "../cics";
import { fastPath } from "./menu";
import { invalidKey, keys, label, lpad, message, newScreen, pad, stamp, time, type Ctx } from "./screen";
import {
	pf, type AbendState, type CebrState, type CedfState, type CemtState, type CicsState, type Input, type Next, type Program, type State,
} from "./program";

// The CICS side of the terminal. CLEAR on a menu blanks the screen, and a
// transaction ID typed there (or on any menu) starts that transaction:
// CINQ 000105, ORDR, MENU. The CICS-supplied transactions are
//	CEMT  master terminal: I TRAN, S TRAN(ORDR) DIS, I TASK, I ENQ
//	CEDF  EDF mode: every screen step of this terminal stops on DFHEDFD,
//	      showing the EIB and the commarea; CEDF OFF ends it
//	CEBR  browse temporary storage queues: CSMT, the abend log, and
//	      CEDFtttt, this terminal's EDF trace
//	CESF  sign off
// cicsWrap runs every panel as a CICS task: a disabled transaction cannot
// be entered, uses are counted, a program that fails abends with a code
// (ASRA, AEIM, AEIP, AEY9) instead of failing the request, and EDF
// intercepts the step.

const DISABLED = (id: string) => `DFHAC2008 TRANSACTION ${id} HAS BEEN DISABLED AND CANNOT BE USED`;

// startTran starts the transaction called id, with rest as what was typed
// after it. here is the screen it was typed on, which CEDF answers on and
// CEMT and CEBR return to. It is undefined when id is not a transaction.
export async function startTran(ctx: Ctx, id: string, rest: string, here: State): Promise<Next | undefined> {
	const t = byId.get(id);
	if (!t) return undefined;
	switch (t.id) {
		case "CEMT":
			return newCemt(ctx, here, rest);
		case "CEBR":
			return { p: "cebr", back: here, queue: rest.split(/\s+/)[0] ?? "" };
		case "CESF":
			return { logoff: `DFHCE3590 SIGN-OFF IS COMPLETE FOR ${ctx.user}` };
		case "CEDF": {
			const off = /^,?\s*OFF$/.test(rest.trim());
			await setEdf(ctx.db, ctx.user, ctx.terminal, !off);
			(here as { msg?: string }).msg = `DFHED0001 THIS TERMINAL: EDF MODE ${off ? "OFF" : "ON"}`;
			return here;
		}
	}
	return fastPath(ctx, t.path ?? "", rest);
}

// --- Running panels as tasks ---

type Programs = Record<string, Program<any>>;

export function cicsWrap<T extends Programs>(programs: T): T {
	const out: Programs = {};
	for (const [p, prog] of Object.entries(programs)) out[p] = p === "cedf" || p === "abend" ? prog : task(prog);
	return out as T;
}

function task(prog: Program<any>): Program<any> {
	return {
		...prog,
		async render(ctx, s) {
			try {
				return await prog.render(ctx, s);
			} catch (e) {
				const a = await abend(ctx, s, e, s.back ?? { p: "menu" });
				// The engine writes the commarea from the state it rendered, so
				// turning s into the abend in place sends the next key to it.
				for (const k of Object.keys(s)) delete s[k];
				Object.assign(s, a);
				return abendPanel.render(ctx, a);
			}
		},
		async handle(ctx, s, input) {
			const before: State = structuredClone(s);
			let next: Next;
			try {
				next = await prog.handle(ctx, s, input);
			} catch (e) {
				return abend(ctx, before, e, before);
			}
			if ("logoff" in next) return next;
			const from = tranOf(before);
			const to = tranOf(next);
			if (!to) return next;
			const step = await stepInfo(ctx.db, to.id, ctx.user, ctx.terminal);
			if (to !== from) {
				if (step.disabled) {
					s.msg = DISABLED(to.id);
					return s;
				}
				await countUse(ctx.db, to.id);
			}
			if (!step.edf) return next;
			const taskn = await nextTask(ctx.db);
			await writeq(ctx.db, edfQueue(ctx.terminal),
				`${time(ctx)} TASK ${lpad(String(taskn), 7)} ${to.id} ${pad(input.aid, 5)} ${before.p} -> ${next.p}  CALEN ${calen(before)}`);
			return {
				p: "cedf", back: next, tran: to.id, program: to.program, task: taskn, aid: input.aid, from: before.p,
				before: commarea(before),
			} satisfies CedfState;
		},
	};
}

async function abend(ctx: Ctx, s: State, e: unknown, back: State): Promise<AbendState> {
	console.error(e);
	const tran = tranOf(s)?.id ?? s.p.toUpperCase().slice(0, 4);
	const a = abendCode(e);
	try {
		await logAbend(ctx.db, ctx.user, ctx.terminal, tran, s.p, a);
	} catch (le) {
		console.error("logging the abend:", le);
	}
	return { p: "abend", back, tran, code: a.code, panel: s.p, text: a.text.slice(0, 300) };
}

// commarea is a panel's state as the program sees it, without the screens
// under it.
function commarea(s: State): string {
	const { back: _back, ...own } = s as State & { back?: unknown };
	return JSON.stringify(own);
}

const calen = (s: State) => JSON.stringify(s).length;

const zpad = (n: number, width: number) => String(n).padStart(width, "0");

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/).filter(Boolean)) {
			for (let w = word; w; w = w.slice(width)) {
				const chunk = w.slice(0, width);
				if (line && line.length + 1 + chunk.length > width) {
					out.push(line);
					line = "";
				}
				line = line ? `${line} ${chunk}` : chunk;
			}
		}
		out.push(line);
	}
	return out;
}

// --- The clear screen ---

export const cics: Program<CicsState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "DFHCLEAR");
		scr.input(1, 2, scr.cols - 3, "tran", "");
		message(scr, s.msg ?? "");
		keys(scr, "TYPE A TRANSACTION ID: MENU  CINQ 000105  CEMT  CEDF  CEBR  CESF");
		scr.cursorTo("tran");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		if (input.aid !== "ENTER") return s;
		const words = (input.fields.tran ?? "").toUpperCase().split(/\s+/).filter(Boolean);
		if (words.length === 0) return s;
		const started = await startTran(ctx, words[0], words.slice(1).join(" "), s);
		if (started) return started;
		s.msg = `DFHAC2001 TRANSACTION '${words[0].slice(0, 8)}' IS NOT RECOGNIZED`;
		return s;
	},
};

// --- Abends ---

const abendMeaning: Record<string, string> = {
	ASRA: "PROGRAM CHECK",
	AEIM: "NOTFND CONDITION NOT HANDLED",
	AEIP: "INVREQ CONDITION NOT HANDLED",
	AEY9: "RESOURCE MANAGER NOT AVAILABLE",
};

export const abendPanel: Program<AbendState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "DFHACABN");
		const w = scr.cols - 3;
		let row = 1;
		for (const line of wrap(`DFHAC2206 ${time(ctx)} ${ctx.system} TRANSACTION ${s.tran} FAILED WITH ABEND ${s.code}.`, w)) {
			scr.text(row++, 2, line, { color: "red", bright: true });
		}
		row++;
		const t = byId.get(s.tran);
		label(scr, row, 2, "TRANSACTION");
		scr.text(row++, 15, `${s.tran}  ${t?.desc ?? ""}`, { color: "white" });
		label(scr, row, 2, "PROGRAM");
		scr.text(row++, 15, `${t?.program ?? "????????"}  PANEL ${s.panel.toUpperCase()}`, { color: "white" });
		label(scr, row, 2, "ABEND CODE");
		scr.text(row++, 15, `${s.code}  ${abendMeaning[s.code] ?? ""}`, { color: "white" });
		label(scr, row, 2, "REASON");
		for (const line of wrap(s.text.toUpperCase(), scr.cols - 16).slice(0, 3)) scr.text(row++, 15, line, { color: "yellow" });
		if (s.why) {
			row++;
			for (const line of s.why.slice(0, Math.max(scr.rows - 3 - row, 0))) scr.text(row++, 2, line, { color: "turquoise" });
		}
		message(scr, s.msg ?? "");
		keys(scr, `ENTER=CONTINUE  PF3=MENU${s.why ? "" : "  PF6=EXPLAIN"}`);
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case "ENTER":
			case "CLEAR":
				return s.back;
			case pf(3):
				return { p: "menu" };
			case pf(6):
				try {
					const why = await explainAbend(ctx.env, { tran: s.tran, desc: byId.get(s.tran)?.desc ?? "", code: s.code, panel: s.panel, text: s.text });
					s.why = wrap(why.toUpperCase(), ctx.cols - 3);
				} catch (e) {
					if (!(e instanceof AiError)) throw e;
					s.msg = "CUS0810W HELP FACILITY NOT AVAILABLE - " + e.message.toUpperCase();
				}
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// --- CEDF ---

const aidHex: Record<string, string> = { ENTER: "7D", CLEAR: "6D", PA1: "6C", PA2: "6E", PA3: "6B" };
const pfHex = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "7A", "7B", "7C", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "4A", "4B", "4C"];

function eibaid(aid: string): string {
	const n = /^PF(\d+)$/.exec(aid);
	return n ? pfHex[Number(n[1]) - 1] ?? "00" : aidHex[aid] ?? "00";
}

// eibdate is 0CYYDDD, the century, year and day of the year; eibtime HHMMSS.
function eib(ctx: Ctx): { date: string; time: string } {
	const d = new Date(Date.now() + ctx.tzOffset * 60_000);
	const day = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
	const y = d.getUTCFullYear();
	return { date: `0${Math.floor(y / 100) - 19}${String(y % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`, time: time(ctx).replaceAll(":", "") };
}

export const cedf: Program<CedfState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "DFHEDFD");
		const w = scr.cols - 3;
		const out = commarea(s.back);
		scr.text(1, 2, `TRANSACTION: ${s.tran}  PROGRAM: ${pad(s.program, 8)}  TASK: ${zpad(s.task, 7)}  APPLID: ${ctx.system}`.slice(0, w), { color: "white", bright: true });
		scr.text(2, 2, "STATUS:  COMMAND EXECUTION COMPLETE", { color: "white", bright: true });
		const lines: [string, string][] = [
			[" EXEC CICS RETURN", "turquoise"],
			[`  TRANSID ('${s.tran}')`, "turquoise"],
			[`  COMMAREA ('${out.slice(0, w - 15)}${out.length > w - 15 ? "..." : ""}')`, "turquoise"],
			[`  LENGTH (${calen(s.back)})`, "turquoise"],
			["", "green"],
		];
		const e = eib(ctx);
		const eibLines = [
			`EIBTIME  = ${e.time}`, `EIBDATE  = ${e.date}`, `EIBTRNID = '${s.tran}'`, `EIBTASKN = ${s.task}`,
			`EIBTRMID = '${termId(ctx.terminal)}'`, `EIBCALEN = ${s.before.length}`, `EIBAID   = X'${eibaid(s.aid)}'  (${s.aid})`,
			`EIBRESP  = 0`,
		];
		for (const l of eibLines) lines.push([" " + l, "green"]);
		lines.push(["", "green"]);
		let row = 3;
		for (const [l, color] of lines) scr.text(row++, 2, l.slice(0, w), { color: color as "green" });

		// The commarea in and out, as much of each as fits.
		const room = Math.max(scr.rows - 2 - row, 2);
		const inLines = wrap(`IN (${s.from.toUpperCase()}): ${s.before}`, w);
		const outLines = wrap(`OUT (${s.back.p.toUpperCase()}): ${out}`, w);
		const nIn = Math.min(inLines.length, Math.max(Math.ceil(room / 2), room - outLines.length));
		for (const l of inLines.slice(0, nIn)) scr.text(row++, 2, l, { color: "yellow" });
		for (const l of outLines.slice(0, room - nIn)) scr.text(row++, 2, l, { color: "white" });

		message(scr, s.msg ?? "");
		keys(scr, "ENTER: CONTINUE   PF3: END EDF SESSION");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		switch (input.aid) {
			case "ENTER":
			case "CLEAR":
				return s.back;
			case pf(3):
				await setEdf(ctx.db, ctx.user, ctx.terminal, false);
				(s.back as { msg?: string }).msg = "DFHED0002 EDF SESSION ENDED";
				return s.back;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// --- CEMT ---

type Resource = "TRAN" | "TASK" | "ENQ";
interface CemtCmd { verb: "I" | "S"; res: Resource; pattern: string; set?: "ENABLED" | "DISABLED" }

function parseCemt(text: string): CemtCmd | string {
	const t = text.toUpperCase().replace(/\s+/g, " ").trim() || "I TRAN";
	const m = /^(I|IN|INQ|INQU|INQUIRE|S|SET) (TRA\w*|TAS\w*|ENQ\w*) ?(?:\( ?([A-Z0-9*+]{0,8}) ?\))? ?(.*)$/.exec(t);
	if (!m) return `DFHEM0101 ${t.slice(0, 40)} IS NOT VALID - TRY I TRAN, S TRAN(ORDR) DIS, I TASK OR I ENQ`;
	const verb = m[1].startsWith("S") ? "S" : "I";
	const res: Resource = m[2].startsWith("TRA") ? "TRAN" : m[2].startsWith("TAS") ? "TASK" : "ENQ";
	const rest = m[4].trim();
	let set: CemtCmd["set"];
	if (/^(ENA|ENABLED?)$/.test(rest)) set = "ENABLED";
	else if (/^(DIS|DISABLED?)$/.test(rest)) set = "DISABLED";
	else if (rest) return `DFHEM0102 ${rest.slice(0, 20)} IS NOT VALID - ENA OR DIS`;
	if (verb === "S" && (res !== "TRAN" || !set)) return "DFHEM0103 SET TAKES TRAN(ID) AND ENA OR DIS";
	return { verb, res, pattern: m[3] || "*", set };
}

function matches(pattern: string, id: string): boolean {
	const re = new RegExp("^" + pattern.replace(/[+]/g, ".").replace(/\*/g, ".*") + "$");
	return re.test(id);
}

// setTrans enables or disables the transactions matching pattern, all but
// the CICS-supplied ones, and says how it went.
async function setTrans(ctx: Ctx, ids: string[], status: "ENABLED" | "DISABLED"): Promise<string> {
	const refused = ids.filter((id) => byId.get(id)?.system);
	const changed = ids.filter((id) => !byId.get(id)?.system);
	for (const id of changed) await setStatus(ctx.db, id, status);
	if (changed.length === 0 && refused.length === 0) return "DFHEM0104 NO TRANSACTION MATCHES";
	if (refused.length > 0) return `DFHEM0105 NOT-AUTH: ${refused.join(" ")} CANNOT BE ${status === "DISABLED" ? "DISABLED" : "CHANGED"}${changed.length ? ` - ${changed.length} NORMAL` : ""}`;
	return `DFHEM0100 RESPONSE: NORMAL - ${changed.length} TRANSACTION${changed.length === 1 ? "" : "S"} ${status}`;
}

export async function newCemt(ctx: Ctx, back: State, cmd: string): Promise<CemtState> {
	const s: CemtState = { p: "cemt", back, cmd: cmd.toUpperCase().trim() || "I TRAN" };
	await runCemt(ctx, s);
	return s;
}

async function runCemt(ctx: Ctx, s: CemtState): Promise<void> {
	s.top = 0;
	const c = parseCemt(s.cmd);
	if (typeof c === "string") {
		s.msg = c;
		return;
	}
	if (c.verb === "S" && c.set) {
		s.msg = await setTrans(ctx, transactions.filter((t) => matches(c.pattern, t.id)).map((t) => t.id), c.set);
	}
}

const cemtRows = (ctx: Ctx) => ctx.rows - 4;

export const cemt: Program<CemtState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "DFHEMTD");
		const w = scr.cols - 3;
		scr.input(1, 2, w, "cmd", s.cmd);
		const c = parseCemt(s.cmd);
		const n = cemtRows(ctx);
		let lines: string[] = [];
		s.ids = undefined;

		if (typeof c !== "string") {
			if (c.res === "TRAN") {
				const stats = await tranStats(ctx.db);
				const list = transactions.filter((t) => matches(c.pattern, t.id));
				const top = Math.min(s.top ?? 0, Math.max(list.length - n, 0));
				scr.text(2, 2, `STATUS:  RESULTS - OVERTYPE TO MODIFY`, { color: "white", bright: true });
				scr.text(2, scr.cols - 20, `${lpad(String(top + 1), 3)}-${lpad(String(Math.min(top + n, list.length)), 3)} OF ${lpad(String(list.length), 3)}`, { color: "white" });
				list.slice(top, top + n).forEach((t, i) => {
					const st = stats.get(t.id)!;
					const row = 3 + i;
					scr.text(row, 2, ` Tra(${t.id}) Pro(${pad(t.program, 8)})`, { color: "turquoise" });
					scr.input(row, 27, 3, `st${i}`, st.status === "ENABLED" ? "Ena" : "Dis", { color: st.status === "ENABLED" ? "green" : "red" });
					const las = st.last_used ? stamp(ctx, st.last_used).slice(5) : "           ";
					const rest = `Use(${zpad(st.uses, 7)}) Abe(${zpad(st.abends, 4)}${st.last_abend ? " " + st.last_abend : ""}) Las(${las}) ${t.desc}`;
					scr.text(row, 31, rest.slice(0, scr.cols - 32), { color: st.abends ? "yellow" : "green" });
				});
				s.ids = list.slice(top, top + n).map((t) => t.id);
				if (list.length === 0) lines = ["NOT FOUND"];
			} else if (c.res === "TASK") {
				const users = await ctx.tso.users();
				lines = users.filter((u) => matches(c.pattern, u.sid) || c.pattern === "*").map((u) =>
					` Tas(${u.sid}) Use(${pad(u.user, 8)}) Ter(${termId(u.terminal)}) Map(${pad(u.map, 8)}) Log(${stamp(ctx, u.logon).slice(11)}) Las(${stamp(ctx, u.seen).slice(11)})`);
				if (lines.length === 0) lines = ["NOT FOUND"];
			} else {
				const locks = await ctx.tso.locks();
				lines = locks.map((l) => ` Enq(${pad(l.resource, 20)}) Use(${pad(l.user, 8)}) Ter(${termId(l.terminal)}) Sin(${stamp(ctx, l.since).slice(11)})`);
				if (lines.length === 0) lines = ["NOT FOUND"];
			}
		}
		if (lines.length > 0) {
			scr.text(2, 2, "STATUS:  RESULTS", { color: "white", bright: true });
			const top = Math.min(s.top ?? 0, Math.max(lines.length - n, 0));
			lines.slice(top, top + n).forEach((l, i) => scr.text(3 + i, 2, l.slice(0, w), { color: l === "NOT FOUND" ? "yellow" : "green" }));
		}

		message(scr, s.msg ?? "");
		keys(scr, "ENTER=APPLY  PF3=END  PF5=REFRESH  PF7=UP  PF8=DOWN");
		scr.cursorTo("cmd");
		return scr;
	},

	async handle(ctx, s, input: Input) {
		s.msg = undefined;
		const n = cemtRows(ctx);
		switch (input.aid) {
			case pf(3):
			case "CLEAR":
				return s.back;
			case pf(5):
				return s;
			case pf(7):
				s.top = Math.max((s.top ?? 0) - n, 0);
				return s;
			case pf(8):
				s.top = (s.top ?? 0) + n;
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const cmd = (input.fields.cmd ?? "").toUpperCase().trim();
		if (cmd !== s.cmd) {
			s.cmd = cmd || "I TRAN";
			await runCemt(ctx, s);
			return s;
		}
		// Overtyped status fields: D disables, E enables.
		const want: Record<"ENABLED" | "DISABLED", string[]> = { ENABLED: [], DISABLED: [] };
		(s.ids ?? []).forEach((id, i) => {
			if (!input.modified.has(`st${i}`)) return;
			const v = (input.fields[`st${i}`] ?? "").trim().toUpperCase();
			if (v.startsWith("D")) want.DISABLED.push(id);
			else if (v.startsWith("E")) want.ENABLED.push(id);
		});
		const said: string[] = [];
		for (const status of ["DISABLED", "ENABLED"] as const) if (want[status].length) said.push(await setTrans(ctx, want[status], status));
		if (said.length > 0) s.msg = said.join("; ");
		return s;
	},
};

// --- CEBR ---

const cebrRows = (ctx: Ctx) => ctx.rows - 5;

export const cebr: Program<CebrState> = {
	async render(ctx, s) {
		const scr = newScreen(ctx, "DFHEDFBR");
		const w = scr.cols - 3;
		const n = cebrRows(ctx);
		let lines: string[];
		let total: number;
		if (s.queue) {
			const top = s.top ?? 0;
			const q = await readq(ctx.db, s.queue, top, n - 1);
			total = q.total;
			lines = q.items.map((d, i) => `${zpad(top + i + 1, 5)} ${d}`);
			if (top === 0) lines.unshift("*".repeat(Math.max((w - 14) >> 1, 0)) + " TOP OF QUEUE " + "*".repeat(Math.max((w - 14) >> 1, 0)));
			if (top + q.items.length >= total) lines.push("*".repeat(Math.max((w - 17) >> 1, 0)) + " BOTTOM OF QUEUE " + "*".repeat(Math.max((w - 17) >> 1, 0)));
			scr.text(1, 2, `CEBR  TSQ ${pad(s.queue, 8)}  SYSID ${ctx.system}  REC ${lpad(String(Math.min(top + 1, total)), 5)} OF ${lpad(String(total), 5)}`, { color: "white", bright: true });
		} else {
			const qs = await queues(ctx.db);
			total = qs.length;
			lines = [`QUEUE     ITEMS  LAST WRITTEN`, ...qs.map((q) => `${pad(q.queue, 8)} ${lpad(String(q.items), 6)}  ${stamp(ctx, q.written)}`)];
			if (qs.length === 0) lines.push("NO TEMPORARY STORAGE QUEUES");
			scr.text(1, 2, `CEBR  TEMPORARY STORAGE QUEUES  SYSID ${ctx.system}`, { color: "white", bright: true });
			if (!s.msg) s.msg = "CEBR: TYPE Q AND A QUEUE NAME, SUCH AS Q CSMT, TO BROWSE IT";
		}
		s.total = total;
		label(scr, 2, 2, "ENTER COMMAND ===>");
		scr.input(2, 21, scr.cols - 22, "cmd", "");
		lines.slice(0, n).forEach((l, i) => scr.text(3 + i, 2, l.slice(0, w), { color: l.startsWith("*") ? "blue" : "green" }));
		message(scr, s.msg ?? "");
		keys(scr, "PF3=TERMINATE BROWSE  PF7=BACK  PF8=FORWARD  Q name  TOP  BOTTOM  PURGE");
		scr.cursorTo("cmd");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = undefined;
		const page = cebrRows(ctx) - 1;
		const last = Math.max((s.total ?? 0) - page, 0);
		switch (input.aid) {
			case pf(3):
			case "CLEAR":
				return s.back;
			case pf(7):
				s.top = Math.max((s.top ?? 0) - page, 0);
				return s;
			case pf(8):
				s.top = Math.min((s.top ?? 0) + page, last);
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(input.aid);
				return s;
		}
		const [verb = "", arg = ""] = (input.fields.cmd ?? "").toUpperCase().split(/\s+/).filter(Boolean);
		switch (verb) {
			case "":
				return s;
			case "Q":
			case "QUEUE":
				s.queue = arg.slice(0, 8);
				s.top = 0;
				return s;
			case "L":
			case "LIST":
				s.queue = "";
				s.top = 0;
				return s;
			case "T":
			case "TOP":
				s.top = 0;
				return s;
			case "B":
			case "BOTTOM":
				s.top = last;
				return s;
			case "P":
			case "PURGE": {
				if (!s.queue) {
					s.msg = "CEBR: NAME A QUEUE TO PURGE - Q NAME FIRST";
					return s;
				}
				const n = await deleteq(ctx.db, s.queue);
				s.msg = `CEBR: QUEUE ${s.queue} PURGED - ${n} ITEMS DELETED`;
				s.top = 0;
				return s;
			}
		}
		s.msg = `CEBR: ${verb.slice(0, 10)} IS NOT A CEBR COMMAND`;
		return s;
	},
};
