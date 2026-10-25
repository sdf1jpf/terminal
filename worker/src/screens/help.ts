import { header, keys, newScreen } from "./screen";
import type { HelpState, Program } from "./program";

// The keyboard tutorial. Any key returns to the screen it was called from.

const rows = [
	["ENTER", "Send the screen to the host (AID key)"],
	["F1 - F12", "PF1 - PF12.  Shift+F1 - F12 are PF13 - PF24"],
	["PGUP / PGDN", "PF7 / PF8 (scroll up / down)"],
	["CTRL+L", "CLEAR key: blank the screen and notify the host"],
	["ALT+1/2/3", "PA1 / PA2 / PA3"],
	["TAB / SHIFT+TAB", "Next / previous input field"],
	["ARROWS, MOUSE", "Move the cursor anywhere on the screen"],
	["HOME / END", "First input field / end of current field"],
	["CTRL+N", "New line: first input field on the next row"],
	["INSERT", "Toggle insert mode (^ shown in the status line)"],
	["CTRL+E", "Erase to end of field (ERASE EOF)"],
	["CTRL+U", "Erase all input fields (ERASE INPUT)"],
	["ESC / CTRL+R", "RESET: unlock the keyboard after an error"],
	["CTRL+C", "Disconnect the terminal session"],
];

export const help: Program<HelpState> = {
	async render(ctx) {
		const scr = newScreen(ctx, "CUSH00");
		header(scr, ctx, "TUTORIAL - USING THIS TERMINAL");

		scr.text(4, 4, "This is a block-mode terminal. You fill in fields locally, then an AID", { color: "green" });
		scr.text(5, 4, "key sends the whole screen to the host, which replies with a new one.", { color: "green" });
		rows.forEach(([k, d], i) => {
			scr.text(7 + i, 4, k, { color: "white", bright: true });
			scr.text(7 + i, 22, d, { color: "turquoise" });
		});
		scr.text(scr.rows - 2, 4, "Status line: X () host busy   X -f protected   X NUM numeric only   X > full",
			{ color: "blue" });

		keys(scr, "PF3=RETURN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	async handle(_ctx, h) {
		return h.back;
	},
};
