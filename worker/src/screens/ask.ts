import { AiError, ask as askAI, explainJob } from "../ai";
import { getJob } from "../jobs";
import { menu } from "./menu";
import { header, invalidKey, keys, label, message, newScreen, pad, type Ctx } from "./screen";
import { pf, type AskState, type Next, type Program, type State } from "./program";

// CUSH02 HELP - ASK asks the system a question in plain English: HELP and
// a question on any command line, or the question typed here. Workers AI
// answers from the HELP facility's knowledge base (ai.ts), and the topics
// it drew on are listed below the answer: S beside one goes to its screen.
//
// CUSJ03 ABEND ANALYSIS is the same panel explaining why a batch job
// failed, from E on the job list or PF6 on its output.

const MAX_REFS = 4;

// wrap breaks text into lines of at most width characters, keeping the
// model's own line breaks.
export function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/).filter(Boolean)) {
			for (let w = word; w; w = w.slice(width)) {
				const part = w.slice(0, width);
				if (line && line.length + 1 + part.length > width) {
					out.push(line);
					line = "";
				}
				line = line ? line + " " + part : part;
			}
		}
		out.push(line);
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}

// newAsk opens the panel, answering q straight away if there is one.
export async function newAsk(ctx: Ctx, back: State, q = ""): Promise<AskState> {
	const s: AskState = { p: "ask", back, q: q.trim() };
	if (s.q) await answer(ctx, s);
	return s;
}

async function answer(ctx: Ctx, s: AskState): Promise<void> {
	s.top = 0;
	const got = await askAI(ctx.env, s.q ?? "");
	s.answer = got.answer;
	s.refs = got.topics.filter((t) => t.go).slice(0, MAX_REFS).map((t) => ({ title: t.title, go: t.go! }));
	if (got.error) {
		s.msg = s.refs.length > 0
			? "CUS1202W HELP FACILITY NOT AVAILABLE - THE NEAREST TOPICS ARE LISTED BELOW"
			: "CUS1202W HELP FACILITY NOT AVAILABLE - TRY PF1 FOR FIELD HELP";
	} else {
		s.msg = "CUS1201I ANSWERED BY THE HELP FACILITY - S BESIDE A TOPIC GOES THERE";
	}
}

// newExplain explains why a job failed. A job that ran clean, or has not
// finished, goes back with a message instead.
export async function newExplain(ctx: Ctx, back: State & { msg?: string }, id: string): Promise<Next> {
	const found = await getJob(ctx.db, id);
	if (!found) {
		back.msg = `CUS0263E JOB ${id} NOT FOUND`;
		return back;
	}
	const { job, output } = found;
	if (job.status !== "OUTPUT") {
		back.msg = `CUS1205W ${job.name} ${job.id} HAS NOT ENDED - NOTHING TO EXPLAIN YET`;
		return back;
	}
	if (job.rc === "0000") {
		back.msg = `CUS1205I ${job.name} ${job.id} ENDED RC=0000 - NOTHING TO EXPLAIN`;
		return back;
	}
	const s: AskState = { p: "ask", back, job: job.id, q: `${job.name} ${job.id} RC=${job.rc}` };
	try {
		s.answer = await explainJob(ctx.env, job, output);
		s.msg = "CUS1206I ANALYSIS BY THE HELP FACILITY - CHECK THE LISTING BEFORE YOU ACT";
	} catch (e) {
		if (!(e instanceof AiError)) throw e;
		s.answer = "";
		s.msg = "CUS1204E ABEND ANALYSIS NOT AVAILABLE - " + e.message.toUpperCase();
	}
	return s;
}

const answerTop = 6;

// layout works out where the answer and the topics go: the topics sit at
// the bottom, above the message line, and the answer scrolls above them.
function layout(ctx: Ctx, s: AskState) {
	const refs = s.refs ?? [];
	const refsTop = refs.length > 0 ? ctx.rows - 2 - refs.length : ctx.rows - 1;
	const rows = Math.max(refsTop - 1 - answerTop, 1);
	const lines = wrap(s.answer ?? "", ctx.cols - 6);
	return { refs, refsTop, rows, lines };
}

export const ask: Program<AskState> = {
	async render(ctx, s) {
		const explaining = s.job !== undefined;
		const scr = newScreen(ctx, explaining ? "CUSJ03" : "CUSH02");
		header(scr, ctx, explaining ? "ABEND ANALYSIS" : "HELP - ASK THE SYSTEM");
		const { refs, refsTop, rows, lines } = layout(ctx, s);
		const top = Math.min(s.top ?? 0, Math.max(lines.length - rows, 0));

		if (explaining) {
			label(scr, 4, 2, "JOB");
			scr.text(4, 6, s.q ?? "", { color: "white", bright: true });
		} else {
			label(scr, 4, 2, "QUESTION ===>");
			scr.input(4, 16, scr.cols - 17, "q", s.q ?? "", { mixed: true });
		}
		if (!explaining && !s.q) {
			scr.text(answerTop, 4, "Ask how to do something, in your own words, and press Enter. For example:", { color: "green" });
			scr.text(answerTop + 2, 6, "How do I put a customer on hold?", { color: "turquoise" });
			scr.text(answerTop + 3, 6, "What does the credit review job do?", { color: "turquoise" });
			scr.text(answerTop + 4, 6, "How do I ship an invoice by UPS?", { color: "turquoise" });
		}
		lines.slice(top, top + rows).forEach((line, i) => scr.text(answerTop + i, 4, line, { color: "green" }));
		if (lines.length > rows) {
			scr.text(answerTop - 1, scr.cols - 22, `LINE ${top + 1}-${Math.min(top + rows, lines.length)} OF ${lines.length}`, { color: "white" });
		}
		if (refs.length > 0) {
			scr.text(refsTop - 1, 2, "S RELATED TOPICS", { color: "white", bright: true });
			refs.forEach((r, i) => {
				const name = `sel:${i}`;
				scr.input(refsTop + i, 2, 1, name, "", { bright: s.errSel === name });
				scr.text(refsTop + i, 4, `${pad(r.title, 50)} ${r.go}`, { color: "turquoise" });
			});
		}

		message(scr, s.msg ?? "");
		keys(scr, lines.length > rows ? "PF1=HELP  PF3=EXIT  PF7=UP  PF8=DOWN  PF12=CANCEL" : "PF1=HELP  PF3=EXIT  PF12=CANCEL");
		if (s.errSel) scr.cursorTo(s.errSel);
		else if (explaining) scr.setCursor(scr.rows, 2);
		else scr.cursorTo("q");
		return scr;
	},

	async handle(ctx, s, input) {
		s.msg = s.errSel = undefined;
		switch (input.aid) {
			case "ENTER": {
				for (const [name, v] of Object.entries(input.fields)) {
					const code = v.trim().toUpperCase();
					if (!name.startsWith("sel:") || code === "") continue;
					const ref = s.refs?.[Number(name.slice(4))];
					if (code !== "S" || !ref) {
						s.msg = `CUS0103E INVALID SELECTION CODE "${code}"`;
						s.errSel = name;
						return s;
					}
					return go(ctx, s, ref.go);
				}
				if (s.job !== undefined) return s;
				const q = (input.fields.q ?? "").trim();
				if (!q) {
					s.q = s.answer = undefined;
					s.refs = [];
					s.msg = "CUS1203I TYPE A QUESTION AND PRESS ENTER";
					return s;
				}
				if (q !== s.q || !s.answer) {
					s.q = q;
					await answer(ctx, s);
				}
				return s;
			}
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
			case pf(8): {
				const { rows, lines } = layout(ctx, s);
				if (input.aid === pf(7)) {
					if (!s.top) s.msg = "CUS0101W ALREADY AT TOP OF DATA";
					s.top = Math.max((s.top ?? 0) - rows, 0);
				} else if ((s.top ?? 0) + rows >= lines.length) {
					s.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
				} else {
					s.top = Math.min((s.top ?? 0) + rows, lines.length - rows);
				}
				return s;
			}
			case "CLEAR":
				if (s.job === undefined) {
					s.q = s.answer = undefined;
					s.refs = [];
				}
				return s;
		}
		s.msg = invalidKey(input.aid);
		return s;
	},
};

// go opens a topic's screen by its command, as if it had been typed on
// the primary menu.
async function go(ctx: Ctx, s: AskState, cmd: string): Promise<Next> {
	if (cmd === "T") return { p: "help", back: s };
	if (cmd === "=") return { p: "menu" };
	return menu.handle(ctx, { p: "menu" }, { aid: "ENTER", fields: { option: cmd }, modified: new Set(["option"]), cursorField: "" });
}
