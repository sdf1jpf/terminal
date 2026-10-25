import { newActivity } from "./activity";
import { newAdd, newInquiry } from "./detail";
import { newEdi } from "./edi";
import { newInvoices } from "./invoices";
import { invalidKey, header, keys, label, message, newScreen, right, time, type Ctx } from "./screen";
import { pf, type MenuState, type Next, type Program } from "./program";

// The ISPF-style primary option menu.

const options = [
	["1", "BROWSE", "Browse the customer master file"],
	["2", "INQUIRY", "Display a customer by number"],
	["3", "ADD", "Add a new customer"],
	["4", "REPORTS", "Credit exposure summary"],
	["5", "EVENTS", "Event history: changes, invoices, payments"],
	["7", "JOBS", "Submit batch jobs and view their output"],
	["8", "PRODUCTS", "Product file and stock on hand"],
	["9", "INVOICES", "Build, bill and collect invoices"],
	["E", "EDI", "EDI mailbox: orders and payments from customers' systems"],
	["T", "TUTORIAL", "Keyboard and PF key guide"],
	["X", "EXIT", "Log off"],
];

export function logoff(ctx: Ctx): Next {
	return { logoff: `IKJ56470I ${ctx.user} LOGGED OFF AT ${time(ctx)}` };
}

export const menu: Program<MenuState> = {
	async render(ctx, m) {
		const scr = newScreen(ctx, "CUSM00");
		header(scr, ctx, "PRIMARY OPTION MENU");

		label(scr, 4, 2, "OPTION ===>");
		scr.input(4, 14, 40, "option", m.option ?? "");

		options.forEach(([key, name, desc], i) => {
			scr.text(6 + i, 4, key, { color: "white", bright: true });
			scr.text(6 + i, 7, name, { color: "turquoise" });
			scr.text(6 + i, 18, desc, { color: "green" });
		});

		const info = [
			["USERID", ctx.user],
			["TIME", time(ctx).slice(0, 5)],
			["TERMINAL", ctx.terminal],
			["SYSTEM", ctx.system],
			["HOST", ctx.host.toUpperCase().slice(0, 14)],
		];
		info.forEach(([k, v], i) => {
			label(scr, 6 + i, right(scr, 56), k);
			scr.text(6 + i, right(scr, 65), "- " + v, { color: "white" });
		});

		scr.text(20, 4, "Enter an option number, or a command such as 2 000105 to jump", { color: "blue" });
		scr.text(21, 4, "straight to a customer. Press PF1 at any time for help.", { color: "blue" });

		message(scr, m.msg ?? "");
		keys(scr, "PF1=HELP  PF3=LOGOFF  PF4=BROWSE  PF12=CANCEL");
		scr.cursorTo("option");
		return scr;
	},

	async handle(ctx, m, input) {
		m.msg = "";
		switch (input.aid) {
			case "ENTER":
				break;
			case pf(3):
				return logoff(ctx);
			case pf(4):
				return { p: "browse" };
			case pf(12):
			case "CLEAR":
				m.option = "";
				return m;
			default:
				m.msg = invalidKey(input.aid);
				return m;
		}

		const opt = (input.fields.option ?? "").toUpperCase().split(/\s+/).filter(Boolean);
		m.option = "";
		if (opt.length === 0) return m;
		const arg = opt[1] ?? "";
		switch (opt[0].replace(/^=/, "")) {
			case "1":
			case "BROWSE":
				return { p: "browse", filter: arg };
			case "2":
			case "INQUIRY":
				return newInquiry(ctx, m, arg);
			case "3":
			case "ADD":
				return newAdd(m);
			case "4":
			case "REPORTS":
				return { p: "report" };
			case "5":
			case "EVENTS":
			case "ACTIVITY":
			case "6": // the old change history, now part of the events
			case "HISTORY":
				return newActivity(ctx, m, arg);
			case "7":
			case "JOBS":
				return { p: "jobs", back: m };
			case "8":
			case "PRODUCTS":
				return { p: "products", filter: arg };
			case "9":
			case "INVOICES":
				return newInvoices(m, arg);
			case "E":
			case "EDI":
				return newEdi(m, arg);
			case "T":
			case "TUTORIAL":
				return { p: "help", back: m };
			case "X":
			case "EXIT":
			case "LOGOFF":
				return logoff(ctx);
		}
		m.option = opt.join(" ");
		m.msg = "ISPD117E INVALID OPTION " + opt[0];
		return m;
	},
};
