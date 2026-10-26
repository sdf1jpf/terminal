import { tutorialKeys } from "@greenscreen-dev/worker";
import { fieldValues, helpFor, type Value } from "./fieldhelp";
import { newAsk } from "./ask";
import { header, keys, message, newScreen, pad, type Ctx } from "./screen";
import { pf, withFill, type HelpState, type Next, type Program } from "./program";

// Help. With a field, it explains that field (CUSH01); PF1 there goes on
// to the keyboard tutorial (CUSH00). Any other key returns to the screen
// help was called from, with what the operator had typed there.
//
// A field with a set of valid values lists them under its help, ISPF prompt
// style: S (or /) beside one returns with it in the field. PF7 and PF8
// scroll a long list.

export const help: Program<HelpState> = {
	async render(ctx, h) {
		const fh = h.field ? await helpFor(ctx.tables, h.back, h.field) : undefined;
		if (fh) {
			const scr = newScreen(ctx, "CUSH01");
			header(scr, ctx, "HELP - " + fh.title);
			fh.lines.forEach((line, i) => scr.text(4 + i, 4, line, { color: "green" }));
			const values = await fieldValues(ctx, fh, h.back);
			if (values.length === 0) {
				keys(scr, "PF1=TUTORIAL  PF3=RETURN");
				scr.setCursor(scr.rows, 2);
				return scr;
			}
			const first = listTop(ctx, fh.lines.length);
			const rows = listRows(ctx, fh.lines.length);
			const top = Math.min(h.top ?? 0, Math.max(values.length - rows, 0));
			const width = Math.max(...values.map((x) => x.code.length));
			scr.text(first - 1, 4, "VALID VALUES - TYPE S BESIDE ONE AND PRESS ENTER TO USE IT", { color: "white", bright: true });
			if (values.length > rows) {
				scr.text(first - 1, scr.cols - 24, `ROW ${top + 1} TO ${Math.min(top + rows, values.length)} OF ${values.length}`, { color: "white" });
			}
			const shown = values.slice(top, top + rows);
			shown.forEach((x, i) => {
				const name = `pick:${top + i}`;
				scr.input(first + i, 4, 1, name, "", { bright: h.errSel === name });
				scr.text(first + i, 6, pad(x.code, width), { color: "white", bright: true });
				scr.text(first + i, 8 + width, x.desc.slice(0, scr.cols - 9 - width), { color: "turquoise" });
			});
			message(scr, h.msg ?? "");
			keys(scr, values.length > rows ? "PF1=TUTORIAL  PF3=RETURN  PF7=UP  PF8=DOWN" : "PF1=TUTORIAL  PF3=RETURN");
			scr.cursorTo(h.errSel && shown.length > 0 ? h.errSel : `pick:${top}`);
			return scr;
		}
		const scr = newScreen(ctx, "CUSH00");
		header(scr, ctx, "TUTORIAL - USING THIS TERMINAL");

		scr.text(4, 4, "This is a block-mode terminal. You fill in fields locally, then an AID", { color: "green" });
		scr.text(5, 4, "key sends the whole screen to the host, which replies with a new one.", { color: "green" });
		tutorialKeys.forEach(([k, d], i) => {
			scr.text(7 + i, 4, k, { color: "white", bright: true });
			scr.text(7 + i, 22, d, { color: "turquoise" });
		});
		scr.text(scr.rows - 2, 4, "Status line: X () host busy   X -f protected   X NUM numeric only   X > full",
			{ color: "blue" });

		keys(scr, "PF3=RETURN  PF5=ASK A QUESTION");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(ctx, h, input) {
		h.msg = h.errSel = undefined;
		if (h.field && input.aid === pf(1)) return { p: "help", back: h.back, vals: h.vals };
		if (!h.field && input.aid === pf(5)) return newAsk(ctx, h.back);
		const fh = h.field ? await helpFor(ctx.tables, h.back, h.field) : undefined;
		const values = fh ? await fieldValues(ctx, fh, h.back) : [];
		if (h.field && values.length > 0) {
			const rows = listRows(ctx, fh!.lines.length);
			switch (input.aid) {
				case "ENTER":
					for (const [name, val] of Object.entries(input.fields)) {
						const code = val.trim().toUpperCase();
						if (!name.startsWith("pick:") || code === "") continue;
						const picked: Value | undefined = values[Number(name.slice(5))];
						if (code !== "S" && code !== "/") {
							h.msg = `CUS0103E INVALID SELECTION CODE "${code}" - TYPE S BESIDE A VALUE`;
							h.errSel = name;
							return h;
						}
						if (picked) return back(h, { [h.field]: picked.code });
					}
					break;
				case pf(7):
					if (!h.top) h.msg = "CUS0101W ALREADY AT TOP OF DATA";
					h.top = Math.max((h.top ?? 0) - rows, 0);
					return h;
				case pf(8):
					if ((h.top ?? 0) + rows >= values.length) h.msg = "CUS0102W ALREADY AT BOTTOM OF DATA";
					else h.top = Math.min((h.top ?? 0) + rows, values.length - rows);
					return h;
			}
		}
		return back(h);
	},
};

// back returns to the screen help was called from with what the operator
// had typed there, and a value picked for the field.
function back(h: HelpState, picked: Record<string, string> = {}): Next {
	const fields = { ...h.vals, ...picked };
	if (Object.keys(fields).length === 0) return h.back;
	return withFill(h.back, { fields, cursor: h.field });
}

// The list of values starts under the field's help and fills the screen
// down to the message line.
const listTop = (_ctx: Ctx, lines: number) => 4 + lines + 2;
const listRows = (ctx: Ctx, lines: number) => Math.max(ctx.rows - 2 - listTop(ctx, lines), 1);
